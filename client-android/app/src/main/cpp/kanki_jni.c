/* JNI lifecycle owns the worker; Java owns TUN until nativeStop has joined. */
#include <jni.h>
#include <pthread.h>
#include <stdatomic.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <arpa/inet.h>
#include <sys/select.h>
#include <android/log.h>
#include "kanki_link.h"

#define PING_EVERY_US   500000    /* liveness probe */
#define HOP_AFTER_US    1500000   /* no PONG this long: move to a fresh UDP port */
#define HOP_EVERY_US    2000000   /* at most one port move per this interval */
#define LOST_AFTER_US   5000000   /* no PONG this long: "reconnecting" */
#define STAT_EVERY_US   5000000   /* downlink quality report to the server */
#define NSTATS          14

static atomic_int running, state, rtt, dn_loss_pm, up_loss_pm, hops, up_repeat, silence_ms, qual_fresh;
static atomic_llong rx_bytes, tx_bytes, dn_lost, dn_rec, up_lost, up_rec;
static pthread_t thread;
static int joinable;
static JavaVM *vm;
static jobject service_ref;
static struct {
    struct sockaddr_in server;
    int tun_fd, repeat, fec_k, fec, autotune, jitter;
    uint8_t key[32];
} cfg;

/* Downlink quality: same rule as the server's uplink accounting. Each logical
   packet has a sequence number; lost = neither a copy nor FEC delivered it. */
static struct {
    dedup_t  seen;
    uint64_t first, max, got, lost_base;
    uint64_t copies, expected, recovered;            /* totals */
    uint64_t s_copies, s_expected, s_lost, s_rec;    /* totals at the last report */
} dq;

static uint64_t dq_lost(void) {
    uint64_t span = dq.first ? dq.max - dq.first + 1 : 0;
    return dq.lost_base + (span > dq.got ? span - dq.got : 0);
}

static int dq_first(uint64_t seq) {
    if (!dq.first || seq > dq.max + 1000000u || seq + DEDUP_BITS < dq.first) {
        dq.lost_base = dq_lost();
        dedup_init(&dq.seen);
        dq.first = dq.max = seq; dq.got = 0;
    }
    if (dedup_seen(&dq.seen, seq)) return 0;
    if (seq < dq.first) dq.first = seq;
    if (seq > dq.max) dq.max = seq;
    dq.got++;
    return 1;
}

static int protect_socket(int fd) {
    JNIEnv *env=NULL;
    if ((*vm)->AttachCurrentThread(vm,&env,NULL)!=JNI_OK) return 0;
    jclass c=(*env)->GetObjectClass(env,service_ref);
    jmethodID m=c?(*env)->GetMethodID(env,c,"protect","(I)Z"):NULL;
    int ok=m&&(*env)->CallBooleanMethod(env,service_ref,m,fd);
    if ((*env)->ExceptionCheck(env)) {(*env)->ExceptionClear(env);ok=0;}
    if(c)(*env)->DeleteLocalRef(env,c);
    (*vm)->DetachCurrentThread(vm);return ok;
}

/* protected, connected, non-blocking UDP socket towards the server */
static int open_transport(void) {
    int fd=socket(AF_INET,SOCK_DGRAM,0);
    if(fd<0)return -1;
    if(fd>=FD_SETSIZE||!protect_socket(fd)||connect(fd,(struct sockaddr*)&cfg.server,sizeof cfg.server)<0){close(fd);return -1;}
    fcntl(fd,F_SETFL,fcntl(fd,F_GETFL)|O_NONBLOCK);
    int bufsize=1<<20;setsockopt(fd,SOL_SOCKET,SO_RCVBUF,&bufsize,sizeof bufsize);
    return fd;
}

/* "QUAL:v1 loss=PERMILLE lost=N rec=N repeat=N": uplink quality from the server */
static void server_qual(const kanki_pkt *k, uint64_t now, uint64_t *qual_at) {
    char m[128]; size_t n=k->payload_len<sizeof m-1?k->payload_len:sizeof m-1;
    memcpy(m,k->payload,n);m[n]=0;
    unsigned loss;unsigned long long lost,rec;int repeat;
    if(sscanf(m,"QUAL:v1 loss=%u lost=%llu rec=%llu repeat=%d",&loss,&lost,&rec,&repeat)!=4)return;
    atomic_store(&up_loss_pm,loss>1000?1000:(int)loss);
    atomic_fetch_add(&up_lost,(long long)lost);atomic_fetch_add(&up_rec,(long long)rec);
    *qual_at=now;
}

static void *worker(void *arg) {
    (void)arg;
    memset(&dq,0,sizeof dq);
    int fd=open_transport();
    kanki_link *up=calloc(1,sizeof *up), *down=calloc(1,sizeof *down);
    int failed=0;
    if(fd<0||!up||!down) {failed=1;goto done;}
    int input=cfg.tun_fd;
    if(input>=FD_SETSIZE){failed=1;goto done;}
    fcntl(input,F_SETFL,fcntl(input,F_GETFL)|O_NONBLOCK);
    link_init(up,cfg.key,cfg.repeat,cfg.fec_k,cfg.fec);
    link_init(down,cfg.key,cfg.repeat,cfg.fec_k,1);
    up->autotune=down->autotune=cfg.autotune;up->cfg.jitter_us=cfg.jitter;
    down->tx=up;
    const struct sockaddr *to=(struct sockaddr*)&cfg.server;
    link_send(up,fd,to,sizeof cfg.server,FLAG_CONTROL,(uint8_t*)"KANKI-HELLO",11);
    uint64_t start=kanki_mono_us(),last_ping=0,last_pong=0,last_hop=start,last_stat=start,qual_at=0;
    uint8_t wire[KANKI_MAX_PKT];
    while(atomic_load(&running)) {
        uint64_t now=kanki_mono_us();
        uint64_t silent=now-(last_pong?last_pong:start);
        /* The operator may silently drop or remap this UDP flow (mobile CGNAT,
           DPI). A fresh socket gives a new public port; the server follows the
           first authenticated packet from it immediately. */
        if(silent>=HOP_AFTER_US&&now-last_hop>=HOP_EVERY_US){
            int fresh=open_transport();
            if(fresh>=0){
                close(fd);fd=fresh;last_hop=now;atomic_fetch_add(&hops,1);
                link_send(up,fd,to,sizeof cfg.server,FLAG_CONTROL,(uint8_t*)"KANKI-HOP",9);
                last_ping=0;
            }
        }
        if(now-last_ping>=PING_EVERY_US) {
            uint8_t m[13];memcpy(m,"PING:",5);
            for(int i=0;i<8;i++)m[5+i]=(uint8_t)(now>>(8*i));
            link_send(up,fd,to,sizeof cfg.server,FLAG_CONTROL,m,sizeof m);last_ping=now;
        }
        if(now-last_stat>=STAT_EVERY_US){
            uint64_t lost=dq_lost(),wc=dq.copies-dq.s_copies,we=dq.expected-dq.s_expected;
            uint64_t wl=lost>dq.s_lost?lost-dq.s_lost:0,wr=dq.recovered-dq.s_rec;
            int pm=we&&wc<we?(int)(1000-wc*1000/we):0;
            atomic_store(&dn_loss_pm,pm);
            dq.s_copies=dq.copies;dq.s_expected=dq.expected;dq.s_lost=lost;dq.s_rec=dq.recovered;
            char m[128];
            int n=snprintf(m,sizeof m,"STAT:v1 rtt=%d loss=%d lost=%llu rec=%llu hops=%d",atomic_load(&rtt),pm,
                           (unsigned long long)wl,(unsigned long long)wr,atomic_load(&hops));
            link_send(up,fd,to,sizeof cfg.server,FLAG_CONTROL,(uint8_t*)m,(uint16_t)n);
            last_stat=now;
        }
        atomic_store(&dn_lost,(long long)dq_lost());atomic_store(&dn_rec,(long long)dq.recovered);
        atomic_store(&silence_ms,(int)(silent/1000>2000000000?2000000000:silent/1000));
        atomic_store(&qual_fresh,qual_at&&now-qual_at<12000000);
        atomic_store(&up_repeat,up->cfg.repeat);
        if(silent>LOST_AFTER_US){atomic_store(&state,1);atomic_store(&rtt,-1);}
        fd_set rf;FD_ZERO(&rf);FD_SET(fd,&rf);FD_SET(input,&rf);
        struct timeval tv=link_poll_tv(up);if(tv.tv_usec>100000)tv.tv_usec=100000;
        int nready=select((fd>input?fd:input)+1,&rf,NULL,NULL,&tv);
        link_fec_idle(up,fd,to,sizeof cfg.server);
        if(nready<0){if(errno==EINTR)continue;failed=1;break;}
        if(!nready)continue;
        if(FD_ISSET(input,&rf)) {
            ssize_t n=read(input,wire,sizeof wire);
            if(n>0 && n<=KANKI_MAX_MTU && kanki_ipv4_valid(wire,n,KANKI_MAX_MTU)) {
                link_send(up,fd,to,sizeof cfg.server,FLAG_DATA,wire,n);atomic_fetch_add(&tx_bytes,n);
            }
        }
        if(FD_ISSET(fd,&rf)) {
            for(int b=0;b<64;b++) {
                ssize_t n=recv(fd,wire,sizeof wire,0);if(n<=0)break;
                kanki_pkt pre;
                int sender_repeat=down->cfg.repeat;
                if(kanki_open2(&down->cfg,wire,n,&pre)==0&&pre.fec_idx!=FEC_PARITY_IDX){
                    dq.copies++;
                    if(dq_first(pre.seq))dq.expected+=(pre.flags&(FLAG_CONTROL|FLAG_TAIL))?MAX_REPEAT:sender_repeat;
                }
                kanki_pkt pkt;int got=link_recv(down,wire,n,&pkt);
                while(got) {
                    if(got==2&&dq_first(pkt.seq)){dq.recovered++;dq.expected+=sender_repeat;}
                    if(pkt.flags&FLAG_DATA) {
                        ssize_t w=-1;
                        if(kanki_ipv4_valid(pkt.payload,pkt.payload_len,KANKI_MAX_MTU)) w=write(input,pkt.payload,pkt.payload_len);
                        if(w>0)atomic_fetch_add(&rx_bytes,w);
                    } else if((pkt.flags&FLAG_CONTROL)&&pkt.payload_len==13&&!memcmp(pkt.payload,"PONG:",5)) {
                        uint64_t sent=0;for(int i=0;i<8;i++)sent|=(uint64_t)pkt.payload[5+i]<<(8*i);
                        uint64_t current=kanki_mono_us();
                        if(sent<=current&&current-sent<=5000000){last_pong=current;atomic_store(&rtt,(current-sent+500)/1000);atomic_store(&state,2);}
                    } else if((pkt.flags&FLAG_CONTROL)&&pkt.payload_len>=5&&!memcmp(pkt.payload,"QUAL:",5)) {
                        server_qual(&pkt,kanki_mono_us(),&qual_at);
                    }
                    got=link_recv_stashed(down,&pkt);
                }
                if(down->pending_tune)link_send_tune(down,fd,to,sizeof cfg.server);
            }
        }
    }
    link_send(up,fd,to,sizeof cfg.server,FLAG_TAIL,NULL,0);
 done:
    if(fd>=0)close(fd);
    free(up);free(down);
    atomic_store(&running,0);atomic_store(&state,failed?-1:0);atomic_store(&rtt,-1);
    return NULL;
}
JNIEXPORT jint JNICALL Java_com_kanki_tunnel_KankiNative_nativeStart(JNIEnv *env,jclass cls,
 jobject service,jstring server,jint port,jstring hex,jint repeat,jint fecK,
 jboolean fec,jboolean autotune,jint jitter,jint tunFd) {
    (void)cls;
    if(atomic_load(&running))return -1;
    if(!service||!server||!hex||port<1||port>65535||
       repeat<3||repeat>10||fecK<2||fecK>MAX_FEC_K||jitter<0||jitter>100000||tunFd<0)return -2;
    if(joinable){pthread_join(thread,NULL);joinable=0;}
    if(service_ref){(*env)->DeleteGlobalRef(env,service_ref);service_ref=NULL;}
    const char *host=(*env)->GetStringUTFChars(env,server,NULL);if(!host)return -3;
    memset(&cfg,0,sizeof cfg);cfg.server.sin_family=AF_INET;cfg.server.sin_port=htons(port);
    int valid=inet_pton(AF_INET,host,&cfg.server.sin_addr)==1;(*env)->ReleaseStringUTFChars(env,server,host);
    const char *key=(*env)->GetStringUTFChars(env,hex,NULL);if(!key)return -3;
    int bad=kanki_parse_key(key,cfg.key);(*env)->ReleaseStringUTFChars(env,hex,key);
    if(!valid||bad)return -2;
    cfg.tun_fd=tunFd;cfg.repeat=repeat;cfg.fec_k=fecK;cfg.fec=fec;
    cfg.autotune=autotune;cfg.jitter=jitter;
    if((*env)->GetJavaVM(env,&vm)!=JNI_OK)return -3;
    service_ref=(*env)->NewGlobalRef(env,service);if(!service_ref)return -3;
    atomic_store(&state,1);atomic_store(&rtt,-1);atomic_store(&rx_bytes,0);atomic_store(&tx_bytes,0);
    atomic_store(&dn_loss_pm,0);atomic_store(&up_loss_pm,0);atomic_store(&hops,0);atomic_store(&up_repeat,repeat);
    atomic_store(&dn_lost,0);atomic_store(&dn_rec,0);atomic_store(&up_lost,0);atomic_store(&up_rec,0);
    atomic_store(&silence_ms,0);atomic_store(&qual_fresh,0);
    atomic_store(&running,1);
    if(pthread_create(&thread,NULL,worker,NULL)) {
        atomic_store(&running,0);atomic_store(&state,-1);(*env)->DeleteGlobalRef(env,service_ref);service_ref=NULL;return -3;
    }
    joinable=1;return 0;
}
JNIEXPORT void JNICALL Java_com_kanki_tunnel_KankiNative_nativeStop(JNIEnv *env,jclass cls) {
    (void)cls;atomic_store(&running,0);if(joinable){pthread_join(thread,NULL);joinable=0;}
    if(service_ref){(*env)->DeleteGlobalRef(env,service_ref);service_ref=NULL;}
}
JNIEXPORT jboolean JNICALL Java_com_kanki_tunnel_KankiNative_nativeRunning(JNIEnv *env,jclass cls){(void)env;(void)cls;return atomic_load(&running)?JNI_TRUE:JNI_FALSE;}
/* see KankiNative.nativeStats for the field order */
JNIEXPORT jlongArray JNICALL Java_com_kanki_tunnel_KankiNative_nativeStats(JNIEnv *env,jclass cls){
    (void)cls;
    jlong v[NSTATS]={atomic_load(&state),atomic_load(&rtt),atomic_load(&rx_bytes),atomic_load(&tx_bytes),
        atomic_load(&dn_loss_pm),atomic_load(&dn_lost),atomic_load(&dn_rec),
        atomic_load(&up_loss_pm),atomic_load(&up_lost),atomic_load(&up_rec),
        atomic_load(&hops),atomic_load(&up_repeat),atomic_load(&silence_ms),atomic_load(&qual_fresh)};
    jlongArray a=(*env)->NewLongArray(env,NSTATS);if(a)(*env)->SetLongArrayRegion(env,a,0,NSTATS,v);return a;
}

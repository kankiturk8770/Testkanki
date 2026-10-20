/* JNI lifecycle owns the worker; Java owns TUN until nativeStop has joined. */
#include <jni.h>
#include <pthread.h>
#include <stdatomic.h>
#include <errno.h>
#include <fcntl.h>
#include <arpa/inet.h>
#include <sys/select.h>
#include <android/log.h>
#include "kanki_link.h"
static atomic_int running, state, rtt;
static atomic_llong rx_bytes, tx_bytes;
static pthread_t thread;
static int joinable;
static JavaVM *vm;
static jobject service_ref;
static struct {
    struct sockaddr_in server;
    int tun_fd, repeat, fec_k, fec, autotune, jitter;
    uint8_t key[32];
} cfg;
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
static void *worker(void *arg) {
    (void)arg;
    int fd=socket(AF_INET,SOCK_DGRAM,0);
    kanki_link *up=calloc(1,sizeof *up), *down=calloc(1,sizeof *down);
    int failed=0;
    if(fd<0||!up||!down||!protect_socket(fd)) {failed=1;goto done;}
    if(connect(fd,(struct sockaddr*)&cfg.server,sizeof cfg.server)<0){failed=1;goto done;}
    int input=cfg.tun_fd;
    if(fd>=FD_SETSIZE||input>=FD_SETSIZE){failed=1;goto done;}
    fcntl(input,F_SETFL,fcntl(input,F_GETFL)|O_NONBLOCK);
    fcntl(fd,F_SETFL,fcntl(fd,F_GETFL)|O_NONBLOCK);
    int bufsize=1<<20;setsockopt(fd,SOL_SOCKET,SO_RCVBUF,&bufsize,sizeof bufsize);
    link_init(up,cfg.key,cfg.repeat,cfg.fec_k,cfg.fec);
    link_init(down,cfg.key,cfg.repeat,cfg.fec_k,1);
    up->autotune=down->autotune=cfg.autotune;up->cfg.jitter_us=cfg.jitter;
    down->tx=up;
    const struct sockaddr *to=(struct sockaddr*)&cfg.server;
    link_send(up,fd,to,sizeof cfg.server,FLAG_CONTROL,(uint8_t*)"KANKI-HELLO",11);
    uint64_t last_ping=0,last_pong=0;
    uint8_t wire[KANKI_MAX_PKT];
    while(atomic_load(&running)) {
        uint64_t now=kanki_mono_us();
        if(now-last_ping>=1000000) {
            uint8_t m[13];memcpy(m,"PING:",5);
            for(int i=0;i<8;i++)m[5+i]=(uint8_t)(now>>(8*i));
            link_send(up,fd,to,sizeof cfg.server,FLAG_CONTROL,m,sizeof m);last_ping=now;
        }
        if(!last_pong||now-last_pong>5000000){atomic_store(&state,1);atomic_store(&rtt,-1);}
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
                kanki_pkt pkt;int got=link_recv(down,wire,n,&pkt);
                while(got) {
                    if(pkt.flags&FLAG_DATA) {
                        ssize_t w=-1;
                        if(kanki_ipv4_valid(pkt.payload,pkt.payload_len,KANKI_MAX_MTU)) w=write(input,pkt.payload,pkt.payload_len);
                        if(w>0)atomic_fetch_add(&rx_bytes,w);
                    } else if((pkt.flags&FLAG_CONTROL)&&pkt.payload_len==13&&!memcmp(pkt.payload,"PONG:",5)) {
                        uint64_t sent=0;for(int i=0;i<8;i++)sent|=(uint64_t)pkt.payload[5+i]<<(8*i);
                        uint64_t current=kanki_mono_us();
                        if(sent<=current&&current-sent<=5000000){last_pong=current;atomic_store(&rtt,(current-sent+500)/1000);atomic_store(&state,2);}
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
    atomic_store(&state,1);atomic_store(&rtt,-1);atomic_store(&rx_bytes,0);atomic_store(&tx_bytes,0);atomic_store(&running,1);
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
JNIEXPORT jlongArray JNICALL Java_com_kanki_tunnel_KankiNative_nativeStats(JNIEnv *env,jclass cls){
    (void)cls;jlong v[4]={atomic_load(&state),atomic_load(&rtt),atomic_load(&rx_bytes),atomic_load(&tx_bytes)};
    jlongArray a=(*env)->NewLongArray(env,4);if(a)(*env)->SetLongArrayRegion(env,a,0,4,v);return a;
}

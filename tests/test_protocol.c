#include "kanki_link.h"
#include <assert.h>
#include <arpa/inet.h>

static void test_crypto(void) {
    uint8_t key[32] = {7}, wrong[32] = {8}, wire[KANKI_MAX_PKT];
    kanki_cfg a = {0}, b = {0}, c = {0}; kanki_pkt p;
    kanki_init(&a,key,4,8,1); kanki_init(&b,key,4,8,1); kanki_init(&c,wrong,4,8,1);
    uint8_t data[1400]; for (int i=0;i<1400;i++) data[i]=(uint8_t)i;
    for (int size=0; size<=1400; size+=100) {
        int n=kanki_seal2(&a,FLAG_DATA,999,23,1,8,data,size,wire);
        assert(n>0 && n<=KANKI_MAX_PKT);
        assert(kanki_open2(&b,wire,n,&p)==0 && p.seq==999 && p.payload_len==size);
        assert(!memcmp(p.payload,data,size));
        assert(kanki_open2(&c,wire,n,&p)!=0);
        wire[n-1]^=1; assert(kanki_open2(&b,wire,n,&p)!=0); wire[n-1]^=1;
        assert(kanki_open2(&b,wire,20,&p)!=0);
    }
}
static void test_dedup(void) {
    dedup_t d; dedup_init(&d);
    assert(!dedup_seen(&d,100000)); assert(dedup_seen(&d,100000));
    assert(!dedup_seen(&d,99999)); assert(dedup_seen(&d,99999));
    assert(!dedup_seen(&d,200000)); assert(dedup_seen(&d,100000));
}
static void test_fec(void) {
    fec_t *f=calloc(1,sizeof *f); assert(f); fec_init(f);
    kanki_pkt shards[4]={0}, parity={0}, out;
    parity.flags=FLAG_PARITY; parity.fec_block=44; parity.fec_idx=255; parity.fec_k=4;
    parity.payload_len=503;
    for(int i=0;i<4;i++) {
        shards[i].flags=FLAG_DATA; shards[i].seq=900+i; shards[i].fec_block=44;
        shards[i].fec_idx=i; shards[i].fec_k=4; shards[i].payload_len=200+i*100;
        memset(shards[i].payload,'A'+i,shards[i].payload_len);
        fec_xor_shard(parity.payload,FLAG_DATA,shards[i].payload,shards[i].payload_len);
        parity.seq^=shards[i].seq;
    }
    for(int missing=0;missing<4;missing++) {
        fec_init(f);
        for(int i=0;i<4;i++) if(i!=missing) assert(!fec_feed(f,&shards[i],&out));
        assert(fec_feed(f,&parity,&out));
        assert(out.seq==shards[missing].seq && out.payload_len==shards[missing].payload_len);
        assert(!memcmp(out.payload,shards[missing].payload,out.payload_len));
        assert(!fec_feed(f,&parity,&out));
    }
    free(f);
}
static void test_repeat_and_idle(void) {
    int rx=socket(AF_INET,SOCK_DGRAM,0),tx=socket(AF_INET,SOCK_DGRAM,0); assert(rx>=0&&tx>=0);
    struct sockaddr_in a={.sin_family=AF_INET,.sin_addr.s_addr=htonl(INADDR_LOOPBACK)};
    assert(!bind(rx,(struct sockaddr*)&a,sizeof a)); socklen_t al=sizeof a; getsockname(rx,(struct sockaddr*)&a,&al);
    uint8_t key[32]={9},wire[KANKI_MAX_PKT];
    kanki_link *l=calloc(1,sizeof *l); assert(l);link_init(l,key,4,8,1);l->cfg.jitter_us=0;
    link_send(l,tx,(struct sockaddr*)&a,sizeof a,FLAG_DATA,(uint8_t*)"test",4);
    for(int i=0;i<4;i++) assert(recv(rx,wire,sizeof wire,MSG_DONTWAIT)>0);
    assert(recv(rx,wire,sizeof wire,MSG_DONTWAIT)<0);
    assert(l->tx_idx==1); usleep(3000);link_fec_idle(l,tx,(struct sockaddr*)&a,sizeof a);
    for(int i=0;i<4;i++) assert(recv(rx,wire,sizeof wire,MSG_DONTWAIT)>0);
    assert(l->tx_idx==0);close(rx);close(tx);free(l);
    uint64_t t=kanki_mono_us();for(int i=0;i<10;i++) kanki_jitter_us(100);
    assert(kanki_mono_us()-t<1000000);
}
int main(void) {test_crypto();test_dedup();test_fec();test_repeat_and_idle();puts("protocol regression: PASS (crypto, tamper, keys, MTU, dedup, FEC, repeat, idle flush, jitter)");}

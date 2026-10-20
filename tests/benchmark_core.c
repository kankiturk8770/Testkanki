#include "kanki_link.h"
#include <assert.h>
#include <sys/resource.h>
int main(int argc,char **argv){
    int count=argc>1?atoi(argv[1]):100;
    if(count<1||count>512)return 2;
    kanki_link **tx=calloc(count,sizeof *tx),**rx=calloc(count,sizeof *rx);
    for(int i=0;i<count;i++){
        uint8_t key[32]={0};memcpy(key,&i,sizeof i);
        tx[i]=calloc(1,sizeof **tx);rx[i]=calloc(1,sizeof **rx);assert(tx[i]&&rx[i]);
        link_init(tx[i],key,4,8,1);link_init(rx[i],key,4,8,1);
    }
    uint8_t data[512]={0},wire[KANKI_MAX_PKT];kanki_pkt pkt;
    uint64_t start=kanki_mono_us();int iterations=20000;
    for(int i=0;i<iterations;i++){
        int u=i%count;int n=kanki_seal2(&tx[u]->cfg,FLAG_DATA,tx[u]->cfg.tx_seq++,i/8,i%8,8,data,sizeof data,wire);
        assert(!kanki_open2(&rx[u]->cfg,wire,n,&pkt));assert(pkt.payload_len==sizeof data);
    }
    uint64_t elapsed=kanki_mono_us()-start;struct rusage usage;getrusage(RUSAGE_SELF,&usage);
    printf("{\"simultaneous_allocated_sessions\":%d,\"link_pair_bytes\":%zu,\"packets\":%d,\"payload_bytes\":512,\"elapsed_ms\":%.2f,\"encrypt_decrypt_pairs_per_second\":%.0f,\"peak_rss_kib\":%ld,\"network_benchmark\":false}\n",count,2*sizeof(kanki_link),iterations,elapsed/1000.0,iterations*1000000.0/elapsed,usage.ru_maxrss);
    for(int i=0;i<count;i++){free(tx[i]);free(rx[i]);}free(tx);free(rx);
}

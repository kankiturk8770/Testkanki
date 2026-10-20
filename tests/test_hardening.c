#include "kanki_link.h"
#include <assert.h>
int main(void){
    uint8_t key[32]={0},wire[KANKI_MAX_PKT],data[KANKI_MAX_PAYLOAD+1]={0};
    kanki_cfg cfg={0};kanki_init(&cfg,key,4,8,1);kanki_pkt pkt;
    assert(kanki_seal2(&cfg,FLAG_DATA,1,0,0,8,data,sizeof data,wire)<0);
    assert(kanki_seal2(&cfg,FLAG_DATA,1,0,0,8,NULL,1,wire)<0);
    assert(kanki_parse_key("agagagagagagagagagagagagagagagagagagagagagagagagagagagagagagagag",key)<0);
    kanki_link *l=calloc(1,sizeof *l);link_init(l,key,4,8,1);
    // TUNE parsing must only read the declared payload, not residual packet memory.
    memset(&pkt,'9',sizeof pkt);pkt.flags=FLAG_CONTROL;pkt.payload_len=6;memcpy(pkt.payload,"TUNE:3",6);
    assert(tune_apply(l,&pkt));assert(l->cfg.repeat==3);
    pkt.payload_len=7;memcpy(pkt.payload,"TUNE:1x",7);assert(!tune_apply(l,&pkt));assert(l->cfg.repeat==3);
    uint8_t ip[28]={0x45,0,0,28};assert(kanki_ipv4_valid(ip,28,1280));ip[3]=27;assert(!kanki_ipv4_valid(ip,28,1280));
    ip[3]=28;ip[0]=0x44;assert(!kanki_ipv4_valid(ip,28,1280));
    // Random malformed ciphertext, truncation and oversized wire lengths.
    for(int i=0;i<2000;i++){int n=i%(sizeof wire);RAND_bytes(wire,sizeof wire);(void)kanki_open2(&cfg,wire,n,&pkt);}
    free(l);puts("hardening: PASS (bounds, bounded TUNE, strict keys, IPv4 framing, malformed wire fuzz)");
}

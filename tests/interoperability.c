/* Compile once with the unchanged v0.2 headers and once with current headers. */
#include "kanki.h"
#include <assert.h>
int main(int argc,char **argv){
    assert(argc==2);uint8_t key[32]={11},wire[KANKI_MAX_PKT];kanki_cfg c={0};kanki_init(&c,key,4,8,1);
    const uint8_t message[]="KANKI v1 wire compatibility";
    if(!strcmp(argv[1],"seal")){
        int n=kanki_seal2(&c,FLAG_DATA,900123,5,2,8,message,sizeof message,wire);assert(n>0);
        assert(fwrite(wire,1,n,stdout)==(size_t)n);
    } else {
        int n=fread(wire,1,sizeof wire,stdin);kanki_pkt p;assert(!kanki_open2(&c,wire,n,&p));
        assert(p.seq==900123&&p.fec_block==5&&p.fec_idx==2&&p.payload_len==sizeof message);
        assert(!memcmp(p.payload,message,sizeof message));puts("wire interoperability: PASS");
    }
}

/* Test-only Linux IP client for the network namespace tests. Not installed. */
#include "kanki_vpnc.h"
#include <linux/if_tun.h>
#include <net/if.h>
#include <sys/ioctl.h>
#include <signal.h>
static volatile int alive=1;
static void stopped(int sig){(void)sig;alive=0;}
int main(int argc,char **argv){
    vpnc_cfg c={.port=4000,.repeat=4,.fec_k=8,.fec_on=1,.autotune=1,.jitter=0};
    const char *keyfile=NULL,*address=NULL;char tun[IFNAMSIZ]="kankic0";int ping=0,mtu=1280;
    for(int i=1;i<argc;i++){
        if(!strcmp(argv[i],"--server")&&i+1<argc)snprintf(c.server,sizeof c.server,"%s",argv[++i]);
        else if(!strcmp(argv[i],"--port")&&i+1<argc){int port=atoi(argv[++i]);if(port<1||port>65535)return 2;c.port=port;}
        else if(!strcmp(argv[i],"--key-file")&&i+1<argc)keyfile=argv[++i];
        else if(!strcmp(argv[i],"--address")&&i+1<argc)address=argv[++i];
        else if(!strcmp(argv[i],"--tun")&&i+1<argc){if(strlen(argv[i+1])>=sizeof tun)return 2;snprintf(tun,sizeof tun,"%s",argv[++i]);}
        else if(!strcmp(argv[i],"--repeat")&&i+1<argc)c.repeat=atoi(argv[++i]);
        else if(!strcmp(argv[i],"--fec-k")&&i+1<argc)c.fec_k=atoi(argv[++i]);
        else if(!strcmp(argv[i],"--jitter")&&i+1<argc)c.jitter=atoi(argv[++i]);
        else if(!strcmp(argv[i],"--mtu")&&i+1<argc)mtu=atoi(argv[++i]);
        else if(!strcmp(argv[i],"--no-fec"))c.fec_on=0;
        else if(!strcmp(argv[i],"--ping"))ping=1;
        else {fprintf(stderr,"Invalid argument: %s\n",argv[i]);return 2;}
    }
    if(!*c.server||!keyfile||(!ping&&!address)){fprintf(stderr,"usage: kanki-vpn-client --server HOST --port 4000 --key-file KEYFILE [--ping | --address 10.66.0.2] [--tun kankic0] [--mtu 1280] [--repeat 4] [--fec-k 8] [--jitter 0] [--no-fec]\n");return 2;}
    if(!c.port||c.repeat<3||c.repeat>10||c.fec_k<2||c.fec_k>16||c.jitter<0||c.jitter>100000||mtu<576||mtu>1400)return 2;
    for(char *p=tun;*p;p++)if(!((*p>='a'&&*p<='z')||(*p>='A'&&*p<='Z')||(*p>='0'&&*p<='9')||*p=='_'||*p=='-'))return 2;
    FILE *f=fopen(keyfile,"r");char hex[128]={0};if(!f){perror(keyfile);return 1;}int ok=fgets(hex,sizeof hex,f)!=NULL;fclose(f);
    hex[strcspn(hex,"\r\n")]=0;if(!ok||kanki_parse_key(hex,c.psk)){fprintf(stderr,"Invalid key file\n");return 2;}
    if(ping){int ms=vpnc_ping(&c,5,1000);printf("{\"rtt_ms\":%d}\n",ms);return ms<0?1:0;}
    struct in_addr addr;if(inet_pton(AF_INET,address,&addr)!=1||(ntohl(addr.s_addr)&0xffff0000)!=0x0a420000)return 2;
    int fd=open("/dev/net/tun",O_RDWR);if(fd<0){perror("TUN");return 1;}
    struct ifreq req={0};req.ifr_flags=IFF_TUN|IFF_NO_PI;snprintf(req.ifr_name,sizeof req.ifr_name,"%s",tun);
    if(ioctl(fd,TUNSETIFF,&req)){perror("TUNSETIFF");close(fd);return 1;}
    char cmd[256];snprintf(cmd,sizeof cmd,"ip address replace %s/32 dev %s && ip link set %s mtu %d up",address,tun,tun,mtu);
    if(system(cmd)){close(fd);return 1;}
    signal(SIGINT,stopped);signal(SIGTERM,stopped);
    fprintf(stderr,"TUN %s ready. Route traffic into it yourself; the server endpoint must stay outside the VPN.\n",tun);
    vpnc_stats stats={0};int result=vpnc_run(&c,fd,&alive,&stats);close(fd);
    fprintf(stderr,"RX=%llu TX=%llu\n",(unsigned long long)stats.rx_bytes,(unsigned long long)stats.tx_bytes);
    return result?1:0;
}

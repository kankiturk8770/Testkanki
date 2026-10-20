#define main vpnd_program_main
#include "kanki-vpnd.c"
#undef main
#include <assert.h>
#include <sys/socket.h>

static vuser *new_user(const char *name,uint8_t secret,const char *ip,const char *group,uint64_t quota){
    vuser *u=calloc(1,sizeof *u);assert(u);snprintf(u->name,sizeof u->name,"%s",name);snprintf(u->group,sizeof u->group,"%s",group);
    memset(u->psk,secret,32);assert(inet_pton(AF_INET,ip,&u->ip)==1);u->quota=quota;
    kanki_init(&u->probe,u->psk,4,8,1);return u;
}
static void ip_packet(uint8_t p[28],uint32_t source,uint32_t dest){
    memset(p,0,28);p[0]=0x45;p[2]=0;p[3]=28;p[8]=64;p[9]=17;memcpy(p+12,&source,4);memcpy(p+16,&dest,4);
}
int main(void){
    inet_pton(AF_INET,"10.66.0.1",&srv_ip);srv_mask=htonl(0xffff0000);
    vuser *nu[2]={new_user("alice-d1",7,"10.66.0.2","alice",56),new_user("alice-d2",8,"10.66.0.3","alice",56)};
    apply_users(nu,2);assert(users[0]->account==users[1]->account);
    int tun[2];assert(!socketpair(AF_UNIX,SOCK_DGRAM,0,tun));
    vport port={.port=4000,.repeat=4,.fec_k=8,.fec_on=1,.fd=socket(AF_INET,SOCK_DGRAM,0)};assert(port.fd>=0);
    struct sockaddr_in from={.sin_family=AF_INET,.sin_port=htons(12345),.sin_addr.s_addr=htonl(INADDR_LOOPBACK)};
    kanki_link *client=calloc(1,sizeof *client);assert(client);link_init(client,users[0]->psk,4,8,1);client->cfg.jitter_us=0;
    uint8_t payload[28],wire[KANKI_MAX_PKT],got[64];uint32_t dst;inet_pton(AF_INET,"1.1.1.1",&dst);
    ip_packet(payload,users[0]->ip,dst);
    uint64_t seq=client->cfg.tx_seq++;
    int n=kanki_seal2(&client->cfg,FLAG_DATA,seq,5,0,8,payload,28,wire);
    port_in(&port,tun[0],wire,n,&from,0);assert(users[0]->bound);
    assert(recv(tun[1],got,sizeof got,MSG_DONTWAIT)==28);assert(!memcmp(got,payload,28));assert(users[0]->account->tx==28);
    port_in(&port,tun[0],wire,n,&from,0);assert(recv(tun[1],got,sizeof got,MSG_DONTWAIT)<0); // replay
    struct sockaddr_in attacker=from;attacker.sin_port=htons(23456);
    port_in(&port,tun[0],wire,n,&attacker,0);assert(users[0]->addr.sin_port==from.sin_port);
    users[0]->last_rx-=11;port_in(&port,tun[0],wire,n,&attacker,0);assert(users[0]->addr.sin_port==from.sin_port); // old replay cannot roam
    n=kanki_seal2(&client->cfg,FLAG_DATA,client->cfg.tx_seq++,6,0,8,payload,28,wire);
    port_in(&port,tun[0],wire,n,&attacker,0);assert(users[0]->addr.sin_port==attacker.sin_port);assert(recv(tun[1],got,sizeof got,MSG_DONTWAIT)==28);
    assert(!within_quota(users[0])&&!within_quota(users[1])); // shared account quota
    users[0]->account->quota=0;users[0]->expires=time(NULL)-1;assert(!within_quota(users[0]));users[0]->expires=0;
    // IP spoofing and inconsistent packet length are rejected before TUN write.
    kanki_pkt k={.flags=FLAG_DATA,.payload_len=28,.seq=client->cfg.tx_seq++};ip_packet(k.payload,users[1]->ip,dst);user_deliver(users[0],tun[0],&k);assert(recv(tun[1],got,sizeof got,MSG_DONTWAIT)<0);
    ip_packet(k.payload,users[0]->ip,dst);k.payload[3]=27;user_deliver(users[0],tun[0],&k);assert(recv(tun[1],got,sizeof got,MSG_DONTWAIT)<0);
    // Actual encrypted reverse datagram: server link -> client receive machinery.
    int rx=socket(AF_INET,SOCK_DGRAM,0);struct sockaddr_in receiver={.sin_family=AF_INET,.sin_addr.s_addr=htonl(INADDR_LOOPBACK)};
    assert(!bind(rx,(struct sockaddr*)&receiver,sizeof receiver));socklen_t len=sizeof receiver;getsockname(rx,(struct sockaddr*)&receiver,&len);
    users[0]->down->cfg.jitter_us=0;ip_packet(payload,dst,users[0]->ip);
    link_send(users[0]->down,port.fd,(struct sockaddr*)&receiver,sizeof receiver,FLAG_DATA,payload,28);
    n=recv(rx,wire,sizeof wire,0);kanki_link *down=calloc(1,sizeof *down);link_init(down,users[0]->psk,4,8,1);
    assert(link_recv(down,wire,n,&k));assert(k.payload_len==28&&!memcmp(k.payload,payload,28));
    assert(!link_recv(down,wire,n,&k));
    // Accounting snapshot survives restart and live reload retains counters.
    char file[]="/tmp/kanki-status-test-XXXXXX";int tmp=mkstemp(file);assert(tmp>=0);close(tmp);status_path=file;
    save_status();accounts[0].tx=0;restore_usage(users,nusers);assert(accounts[0].tx==56);assert(users[0]->replay_floor>0);unlink(file);status_path=NULL;
    vuser *reload_users[1]={new_user("alice-d1",7,"10.66.0.2","alice",100)};apply_users(reload_users,1);
    assert(users[0]->bound&&users[0]->account->tx==56&&users[0]->account->quota==100);
    vuser *disabled[1]={new_user("alice-d1",7,"10.66.0.2","alice",100)};
    disabled[0]->expires=1;apply_users(disabled,1);
    assert(!within_quota(users[0])&&users[0]->account->tx==56);
    vuser *enabled[1]={new_user("alice-d1",7,"10.66.0.2","alice",100)};
    apply_users(enabled,1);assert(within_quota(users[0])&&users[0]->account->tx==56);
    close(rx);close(port.fd);close(tun[0]);close(tun[1]);free(client);free(down);user_free(users[0]);nusers=0;
    // Deleted-account churn must not exhaust the table for new subscribers.
    memset(accounts,0,sizeof accounts);naccounts=MAX_USERS;
    for(int i=0;i<MAX_USERS;i++)snprintf(accounts[i].name,sizeof accounts[i].name,"retired-%d",i);
    vuser *fresh[1]={new_user("fresh-d1",9,"10.66.0.4","fresh",1024)};
    apply_users(fresh,1);assert(naccounts==1&&within_quota(users[0]));assert(users[0]->account->rx==0&&users[0]->account->tx==0);
    apply_users(NULL,0);assert(naccounts==0);
    // Panel port changes are applied live: unchanged listeners keep their socket,
    // a changed listener is reopened and its sessions reconnect.
    char conf[]="/tmp/kanki-conf-test-XXXXXX";int cf=mkstemp(conf);assert(cf>=0);conf_path=conf;
    dprintf(cf,"tun kanki0\naddress 10.66.0.1/16\nmtu 1280\nport udp 47101 repeat=4\n");close(cf);
    vuser *none[1];int count=0;nports=0;assert(!load_conf(0,none,&count)&&nports==1);assert(!port_open(&ports[0]));
    int first_fd=ports[0].fd;
    vuser *live[1]={new_user("live-d1",10,"10.66.0.5","live",0)};apply_users(live,1);users[0]->bound=1;users[0]->port=&ports[0];
    FILE *cfw=fopen(conf,"w");fprintf(cfw,"mtu 1280\nport udp 47101 repeat=4\nport udp 47102 repeat=6\nuser live-d1 %s 10.66.0.5\n","0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a");fclose(cfw);
    vuser *again[MAX_USERS];assert(!load_conf(1,again,&count)&&next_nports==2);apply_users(again,count);
    assert(!apply_listeners(users,nusers)&&nports==2&&ports[0].fd==first_fd&&ports[1].port==47102&&ports[1].repeat==6);
    assert(users[0]->bound&&users[0]->port==&ports[0]);
    cfw=fopen(conf,"w");fprintf(cfw,"port udp 47103 repeat=4\nuser live-d1 %s 10.66.0.5\n","0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a");fclose(cfw);
    assert(!load_conf(1,again,&count));apply_users(again,count);
    assert(!apply_listeners(users,nusers)&&nports==1&&ports[0].port==47103&&!users[0]->bound);
    cfw=fopen(conf,"w");fprintf(cfw,"port udp 47104\nport udp 47104\n");fclose(cfw);
    assert(load_conf(1,again,&count)<0); // duplicate listener rejected, old table kept
    assert(nports==1&&ports[0].port==47103);
    close(ports[0].fd);unlink(conf);apply_users(NULL,0);
    puts("VPN datapath integration: PASS (encrypted IPv4 both ways, replay, roaming, spoofing, MTU, shared quota, expiry, reload, persistence, live listeners)");
}

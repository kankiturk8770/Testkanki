/* kanki-vpnd.c — multi-user KANKI VPN server: TUN device <-> kanki tunnel.
   Every user has its own PSK and tunnel IP; every listening port is a
   profile (repeat / FEC / jitter / transport). Config: /etc/kanki/kanki.conf
     tun kanki0
     address 10.66.0.1/16
     mtu 1280
     port udp 4000 name=Game repeat=3 fec_k=8 fec=1 autotune=1 jitter=0
     port faketcp 4443 name=FakeTCP repeat=4
     user NAME KEYHEX 10.66.0.2 [TOKEN]
   Changes to users, port lines and mtu are applied while running (file change
   or SIGHUP); tun and address changes need a restart. */
#include "kanki_link.h"
#include "kanki_credit.h"
#include <arpa/inet.h>
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/if_tun.h>
#include <net/if.h>
#include <signal.h>
#include <sys/ioctl.h>
#include <sys/select.h>
#include <sys/stat.h>
#include <inttypes.h>
#include <stdarg.h>

#define MAX_PORTS      8
#define MAX_USERS      4096
#define SESSION_IDLE_S 300        /* unbind a user after 5 min of silence */
#define QUAL_WINDOW_S  10         /* connection-quality window */
#define QUAL_REPORT_S  5          /* QUAL message to the client */
#define EVENTS_MAX     (4 << 20)  /* events log rotates at 4 MiB */

typedef struct {
    int      faketcp;
    uint16_t port;
    int      repeat, fec_k, fec_on, autotune, jitter;
    int      fd;                  /* UDP socket or raw TCP socket */
    ftcp_t   rx;                  /* fake-TCP: receive side (unpinned) */
} vport;

typedef struct { char name[64]; uint64_t rx, tx, quota; } account;
static account accounts[MAX_USERS];
static int naccounts;
static const char *status_path = NULL;
static const char *credit_path = NULL;
static credit_store credits = {.fd=-1};

static account *account_get(const char *name) {
    for (int i=0;i<naccounts;i++) if (!strcmp(accounts[i].name,name)) return &accounts[i];
    if (naccounts >= MAX_USERS) return NULL;
    account *a=&accounts[naccounts++]; memset(a,0,sizeof *a); snprintf(a->name,sizeof a->name,"%s",name); return a;
}

/* Connection quality of one device. Uplink (client -> server) is measured
   here; downlink is measured by the client and reported in STAT messages.
   Every logical packet carries a sequence number, so a packet is "lost" when
   neither a copy nor FEC recovery delivered it. */
typedef struct { uint64_t copies, expected, unique, recovered, lost; } qcount;
typedef struct {
    dedup_t  seen;                /* logical packets delivered (direct or FEC) */
    uint64_t first_seq, max_seq, got, lost_base;
    qcount   total, snap, win;    /* totals, totals at last window edge, last window */
    time_t   win_at, since, last_loss_event, qual_at;
    uint32_t roams;
    uint64_t rx_bytes, tx_bytes;  /* payload bytes to / from this device */
    /* reported by the client for the downlink (server -> client) */
    int      c_rtt;
    uint32_t c_loss_pm, c_hops;
    uint64_t c_lost, c_rec, c_tlost, c_trec;
    time_t   c_at;
} qstat;

typedef struct {
    char        name[64];
    char        group[64];
    uint64_t    quota, expires, replay_floor;
    account    *account;
    uint8_t     psk[32];
    uint32_t    ip;               /* tunnel IP, network order */
    kanki_cfg   probe;            /* key cache to recognise this user's packets */
    kanki_link *up, *down;        /* allocated on first contact */
    int         bound;
    vport      *port;
    struct sockaddr_in addr;
    ftcp_t      ft;               /* fake-TCP send state towards this user */
    time_t      last_rx;
    qstat      *q;                /* allocated with the links */
    int         limit_state;      /* 0 ok, 1 expired/disabled, 2 quota: logged on change */
} vuser;

static volatile sig_atomic_t running = 1, reload = 0;
static void on_sig(int s) { if (s == SIGHUP) reload = 1; else running = 0; }

static int check_only;
static uint64_t config_generation;
static const char *conf_path = "/etc/kanki/kanki.conf";
static char     tun_name[IFNAMSIZ] = "kanki0";
static uint32_t srv_ip, srv_mask;          /* network order */
static int      srv_prefix = 16, tun_mtu = 1280;
static vport    ports[MAX_PORTS];
static int      nports;
static vport    next_ports[MAX_PORTS];     /* listener set parsed on reload */
static int      next_nports, next_mtu;
static vuser   *users[MAX_USERS];
static int      nusers;
static int16_t  ip_map[65536];             /* low 16 bits of tunnel IP -> user index */

static int parse_psk(const char *hex, uint8_t psk[32]) {
    return kanki_parse_key(hex, psk);
}

static int clampi(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

/* ---------- config ---------- */

static int parse_port(char *args, vport *p) {
    char *tok = strtok(args, " \t");
    if (!tok) return -1;
    if (!strcmp(tok, "udp")) p->faketcp = 0;
    else if (!strcmp(tok, "faketcp")) p->faketcp = 1;
    else return -1;
    tok = strtok(NULL, " \t");
    if (!tok || atoi(tok) <= 0 || atoi(tok) > 65535) return -1;
    p->port = (uint16_t)atoi(tok);
    p->repeat = DEFAULT_REPEAT; p->fec_k = DEFAULT_FEC_K; p->fec_on = 1;
    p->autotune = 1; p->jitter = 0;
    while ((tok = strtok(NULL, " \t"))) {
        char *eq = strchr(tok, '=');
        if (!eq) continue;
        *eq = 0; int v = atoi(eq + 1);
        if (!strcmp(tok, "repeat")) p->repeat = clampi(v, MIN_REPEAT, MAX_REPEAT);
        else if (!strcmp(tok, "fec_k")) p->fec_k = clampi(v, 2, MAX_FEC_K);
        else if (!strcmp(tok, "fec")) p->fec_on = v != 0;
        else if (!strcmp(tok, "autotune")) p->autotune = v != 0;
        else if (!strcmp(tok, "jitter")) p->jitter = clampi(v, 0, 100000);
        /* name= and other keys are for kanki-admin / the subscription */
    }
    return 0;
}

/* read the config. mode 0: everything (startup); mode 1: users, port lines
   and mtu only, ports into next_ports[] (live reload). */
static int load_conf(int users_only, vuser **out, int *nout) {
    next_nports = 0; next_mtu = tun_mtu;
    FILE *f = fopen(conf_path, "r");
    if (!f) { perror(conf_path); return -1; }
    char line[1024]; int ln = 0, n = 0, errors = 0;
    uint64_t next_generation=config_generation;
    while (fgets(line, sizeof line, f)) {
        ln++;
        char *s = line; while (isspace((unsigned char)*s)) s++;
        char *e = s + strlen(s); while (e > s && isspace((unsigned char)e[-1])) *--e = 0;
        if (!*s || *s == '#') continue;
        char *kw = strtok(s, " \t"), *rest = strtok(NULL, "");
        if (!rest) rest = "";
        if (!strcmp(kw, "user")) {
            char name[64], key[80], ip[32];
            if (sscanf(rest, "%63s %79s %31s", name, key, ip) != 3) goto bad;
            if (n >= MAX_USERS) goto bad;
            vuser *u = calloc(1, sizeof *u);
            if (!u) goto bad;
            for (char *c=name;*c;c++) if (!isalnum((unsigned char)*c) && *c!='_' && *c!='-') { free(u); goto bad; }
            snprintf(u->name, sizeof u->name, "%s", name);
            snprintf(u->group,sizeof u->group,"%s",name);
            char group[64]; unsigned long long quota;
            if (sscanf(rest,"%*s %*s %*s %*s group=%63s quota=%llu",group,&quota)==2) {
                for (char *c=group;*c;c++) if (!isalnum((unsigned char)*c) && *c!='_' && *c!='-') { free(u); goto bad; }
                snprintf(u->group,sizeof u->group,"%s",group);u->quota=quota;
            }
            if (parse_psk(key, u->psk) != 0 || inet_pton(AF_INET, ip, &u->ip) != 1) { free(u); goto bad; }
            uint32_t host=ntohl(u->ip), mask=ntohl(srv_mask);
            if ((u->ip & srv_mask)!=(srv_ip & srv_mask) || u->ip==srv_ip ||
                (host & ~mask)==0 || (host & ~mask)==(~mask)) { free(u); goto bad; }
            for (int j=0;j<n;j++) if (out[j]->ip==u->ip || !strcmp(out[j]->name,u->name) ||
                !memcmp(out[j]->psk,u->psk,32)) { free(u); goto bad; }
            const char *expiry=strstr(rest," expires=");
            if(expiry)u->expires=strtoull(expiry+9,NULL,10);
            kanki_init(&u->probe, u->psk, DEFAULT_REPEAT, DEFAULT_FEC_K, 1);
            out[n++] = u;
        } else if (!strcmp(kw,"generation")) {
            char *tail;errno=0;unsigned long long value=strtoull(rest,&tail,10);
            if(errno||!*rest||*tail||value>UINT64_C(9007199254740991))goto bad;
            next_generation=value;
        } else if (users_only && !strcmp(kw, "mtu")) {
            next_mtu = clampi(atoi(rest), 576, KANKI_MAX_MTU);
        } else if (users_only && !strcmp(kw, "port")) {
            if (next_nports >= MAX_PORTS || parse_port(rest, &next_ports[next_nports]) != 0) goto bad;
            for (int j = 0; j < next_nports; j++)
                if (next_ports[j].port == next_ports[next_nports].port &&
                    next_ports[j].faketcp == next_ports[next_nports].faketcp) goto bad;
            next_nports++;
        } else if (users_only) {
            continue;
        } else if (!strcmp(kw, "tun")) {
            if (strlen(rest) >= IFNAMSIZ) goto bad;
            for (const char *c = rest; *c; c++) if (!isalnum((unsigned char)*c) && *c != '-' && *c != '_') goto bad;
            snprintf(tun_name, sizeof tun_name, "%s", rest);
        } else if (!strcmp(kw, "address")) {
            char a[32]; int pfx;
            if (sscanf(rest, "%31[0-9.]/%d", a, &pfx) != 2 || pfx < 16 || pfx > 30 ||
                inet_pton(AF_INET, a, &srv_ip) != 1) goto bad;
            srv_prefix = pfx;
            srv_mask = htonl(0xFFFFFFFFu << (32 - pfx));
        } else if (!strcmp(kw, "mtu")) {
            tun_mtu = clampi(atoi(rest), 576, KANKI_MAX_MTU);
        } else if (!strcmp(kw, "port")) {
            if (nports >= MAX_PORTS || parse_port(rest, &ports[nports]) != 0) goto bad;
            for (int j = 0; j < nports; j++)
                if (ports[j].port == ports[nports].port && ports[j].faketcp == ports[nports].faketcp) goto bad;
            nports++;
        }   /* domain, dns, ... : used by kanki-admin only */
        continue;
    bad:
        errors++;
        fprintf(stderr, "%s:%d: bad line\n", conf_path, ln);
    }
    fclose(f);
    if (errors) {
        for (int i=0;i<n;i++) free(out[i]);
        *nout=0; return -1;
    }
    *nout = n;
    config_generation=next_generation;
    return 0;
}

static void user_free(vuser *u) {
    if (!u) return;
    free(u->up); free(u->down); free(u->q); free(u);
}

/* (re)build users[] keeping live sessions of users whose key did not change */
static void apply_users(vuser **nu, int n) {
    for (int i = 0; i < n; i++) {
        for (int j = 0; j < nusers; j++) {
            vuser *o = users[j];
            if (o && !strcmp(o->name, nu[i]->name) && !memcmp(o->psk, nu[i]->psk, 32) &&
                o->ip == nu[i]->ip) {
                o->expires=nu[i]->expires; o->quota=nu[i]->quota; snprintf(o->group,sizeof o->group,"%s",nu[i]->group);
                user_free(nu[i]); nu[i] = o; users[j] = NULL; break;
            }
        }
    }
    for (int j = 0; j < nusers; j++) user_free(users[j]);
    /* Keep counters only for accounts still present in the new configuration.
       Otherwise churn through deleted account names would permanently exhaust
       the fixed MAX_USERS accounting table. Rebind every pointer below. */
    static account kept[MAX_USERS];int nkept=0;
    for(int a=0;a<naccounts;a++)for(int i=0;i<n;i++)
        if(!strcmp(accounts[a].name,nu[i]->group)){kept[nkept++]=accounts[a];break;}
    memcpy(accounts,kept,(size_t)nkept*sizeof *accounts);naccounts=nkept;
    memset(ip_map, 0xFF, sizeof ip_map);
    for (int i = 0; i < n; i++) {
        users[i] = nu[i];
        users[i]->account=account_get(users[i]->group);
        if (users[i]->account) users[i]->account->quota=users[i]->quota;
        uint32_t h = ntohl(users[i]->ip);
        if ((users[i]->ip & srv_mask) != (srv_ip & srv_mask) || users[i]->ip == srv_ip)
            fprintf(stderr, "[kanki] user %s: %s is outside the tunnel network, ignored\n",
                    users[i]->name, inet_ntoa(*(struct in_addr *)&users[i]->ip));
        else ip_map[h & 0xFFFF] = (int16_t)i;
    }
    nusers = n;
    fprintf(stderr, "[kanki] %d user(s) loaded\n", nusers);
}

/* ---------- events log ---------- */

static const char *events_path = NULL;

/* One line per event: "UNIX_TIME DEVICE ACCOUNT TYPE key=value ...". The panel
   reads it; the same text also goes to the journal. */
static void event_log(const vuser *u, const char *type, const char *fmt, ...) {
    char detail[512] = "";
    if (fmt) { va_list ap; va_start(ap, fmt); vsnprintf(detail, sizeof detail, fmt, ap); va_end(ap); }
    fprintf(stderr, "[kanki] %s %s %s\n", u ? u->name : "-", type, detail);
    if (!events_path) return;
    struct stat st;
    if (!stat(events_path, &st) && st.st_size > EVENTS_MAX) {
        char old[4096];
        if (snprintf(old, sizeof old, "%s.1", events_path) < (int)sizeof old) rename(events_path, old);
    }
    int fd = open(events_path, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0640);
    if (fd < 0) return;
    char line[700];
    int n = snprintf(line, sizeof line, "%lld %s %s %s %s\n", (long long)time(NULL),
                     u ? u->name : "-", u ? u->group : "-", type, detail);
    if (n > 0) { ssize_t w = write(fd, line, (size_t)(n < (int)sizeof line ? n : (int)sizeof line - 1)); (void)w; }
    close(fd);
}

static const char *endpoint_str(const struct sockaddr_in *a, char *buf, size_t n) {
    char ip[INET_ADDRSTRLEN];
    inet_ntop(AF_INET, &a->sin_addr, ip, sizeof ip);
    snprintf(buf, n, "%s:%d", ip, ntohs(a->sin_port));
    return buf;
}

/* ---------- connection quality ---------- */

static uint64_t q_stream_lost(const qstat *q) {
    if (!q->first_seq) return 0;
    uint64_t span = q->max_seq - q->first_seq + 1;
    return span > q->got ? span - q->got : 0;
}

/* 1 when seq is delivered for the first time. A new client session starts a
   new sequence space, so a far jump starts a new stream. */
static int q_first(qstat *q, uint64_t seq) {
    if (!q->first_seq || seq > q->max_seq + 1000000u || seq + DEDUP_BITS < q->first_seq) {
        q->lost_base += q_stream_lost(q);
        dedup_init(&q->seen);
        q->first_seq = q->max_seq = seq; q->got = 0;
    }
    if (dedup_seen(&q->seen, seq)) return 0;
    if (seq < q->first_seq) q->first_seq = seq;
    if (seq > q->max_seq) q->max_seq = seq;
    q->got++;
    return 1;
}

static void q_copy(qstat *q, const kanki_pkt *k, int sender_repeat) {
    if (k->fec_idx == FEC_PARITY_IDX) return;
    q->total.copies++;
    if (q_first(q, k->seq)) {
        q->total.unique++;
        q->total.expected += (k->flags & (FLAG_CONTROL | FLAG_TAIL)) ? MAX_REPEAT : sender_repeat;
    }
}

static void q_recovered(qstat *q, const kanki_pkt *k, int sender_repeat) {
    if (q_first(q, k->seq)) { q->total.recovered++; q->total.expected += sender_repeat; }
}

static uint32_t q_loss_pm(const qcount *c) {
    if (!c->expected || c->copies >= c->expected) return 0;
    return (uint32_t)(1000 - c->copies * 1000 / c->expected);
}

/* close the current window; log a quality event when packets were lost */
static void q_roll(vuser *u, time_t now) {
    qstat *q = u->q;
    if (!q || now - q->win_at < QUAL_WINDOW_S) return;
    q->total.lost = q->lost_base + q_stream_lost(q);
    qcount w = { q->total.copies - q->snap.copies, q->total.expected - q->snap.expected,
                 q->total.unique - q->snap.unique, q->total.recovered - q->snap.recovered,
                 q->total.lost > q->snap.lost ? q->total.lost - q->snap.lost : 0 };
    q->win = w; q->snap = q->total; q->win_at = now;
    uint32_t pm = q_loss_pm(&w);
    int client_fresh = now - q->c_at <= 2 * QUAL_REPORT_S;
    if (u->bound && (w.lost || pm >= 200 || (client_fresh && (q->c_lost || q->c_loss_pm >= 200))) &&
        now - q->last_loss_event >= 30) {
        q->last_loss_event = now;
        event_log(u, "quality", "up_loss=%u.%u%% up_lost=%" PRIu64 " up_fec=%" PRIu64
                  " down_loss=%u.%u%% down_lost=%" PRIu64 " down_fec=%" PRIu64 " rtt=%d repeat=%d",
                  pm / 10, pm % 10, w.lost, w.recovered, q->c_loss_pm / 10, q->c_loss_pm % 10,
                  client_fresh ? q->c_lost : 0, client_fresh ? q->c_rec : 0, q->c_rtt,
                  u->down ? u->down->cfg.repeat : 0);
    }
}

/* Accounting is payload bytes (both directions), shared by all device slots.
   Atomic snapshots survive clean restarts. A crash can lose at most one flush interval. */
static int within_quota(vuser *u) {
    account *a=u->account;
    if ((u->expires && (uint64_t)time(NULL)>=u->expires) || !a) return 0;
    if (credits.fd>=0) return credit_available(&credits,a->name,a->quota)>0;
    return !a->quota || (a->rx<a->quota && a->tx<a->quota-a->rx);
}
static int debit_packet(vuser *u, uint64_t len) {
    if(!within_quota(u))return 0;
    account *a=u->account;
    if(credits.fd>=0){
        int result=credit_charge(&credits,a->name,a->quota,len);
        if(result<0){fprintf(stderr,"[kanki] durable credit storage failed; stopping without forwarding\n");running=0;}
        return result==1;
    }
    return !a->quota || len<=a->quota-a->rx-a->tx;
}
static void restore_usage(vuser **list, int count) {
    if (!status_path) return;
    FILE *f=fopen(status_path,"r"); if (!f) return;
    char line[512],name[64]; unsigned long long rx,tx;
    while (fgets(line,sizeof line,f)) {
        if (sscanf(line,"account %63s %llu %llu",name,&rx,&tx)==3) {
            int present=0;for(int i=0;i<count;i++)if(!strcmp(list[i]->group,name)){present=1;break;}
            if(present){account *a=account_get(name); if(a) { a->rx=rx; a->tx=tx; }}
        } else {
            char group[64],ip[32];int bound;long long seen;unsigned long long top;
            if(sscanf(line,"session %63s %63s %d %31s %lld %llu",name,group,&bound,ip,&seen,&top)==6)
                for(int i=0;i<count;i++)if(!strcmp(list[i]->name,name))list[i]->replay_floor=top;
        }
    }
    fclose(f);
}
static void save_status(void) {
    if (!status_path) return;
    char tmp[4096]; if (snprintf(tmp,sizeof tmp,"%s.XXXXXX",status_path)>=(int)sizeof tmp) return;
    int fd=mkstemp(tmp);if(fd<0)return; fchmod(fd,0640);
    FILE *f=fdopen(fd,"w");if(!f){close(fd);unlink(tmp);return;}
    fprintf(f,"KANKI_STATUS_V1 %lld %ld %s\n",(long long)time(NULL),(long)getpid(),credits.fd>=0?"credit-v1":"local");
    fprintf(f,"generation %" PRIu64 "\n",config_generation);
    for(int i=0;i<naccounts;i++) fprintf(f,"account %s %" PRIu64 " %" PRIu64 " %" PRIu64 " %" PRIu64 "\n",
        accounts[i].name,accounts[i].rx,accounts[i].tx,accounts[i].quota,
        credits.fd>=0?credit_reserved(&credits,accounts[i].name):0);
    for(int i=0;i<nusers;i++) {
        vuser *u=users[i];char ip[INET_ADDRSTRLEN];inet_ntop(AF_INET,&u->ip,ip,sizeof ip);
        uint64_t top=u->up?u->up->dedup.top:u->replay_floor;
        /* fields 1-6 are read by older panels/agents; quality fields follow */
        fprintf(f,"session %s %s %d %s %lld %" PRIu64,u->name,u->group,u->bound && within_quota(u),ip,(long long)u->last_rx,top);
        qstat *q=u->q;
        if(q){
            char ep[64];if(u->bound)endpoint_str(&u->addr,ep,sizeof ep);else snprintf(ep,sizeof ep,"-");
            int fresh=time(NULL)-q->c_at<=2*QUAL_REPORT_S;
            fprintf(f," %s %lld %u %u %" PRIu64 " %" PRIu64 " %u %" PRIu64 " %" PRIu64 " %d %d %" PRIu64 " %" PRIu64 " %u %" PRIu64 " %" PRIu64 " %" PRIu64 " %" PRIu64,
                ep,(long long)q->since,q->roams,q_loss_pm(&q->win),q->win.lost,q->win.recovered,
                fresh?q->c_loss_pm:0,fresh?q->c_lost:0,fresh?q->c_rec:0,fresh?q->c_rtt:-1,
                u->down?u->down->cfg.repeat:0,q->rx_bytes,q->tx_bytes,q->c_hops,
                q->total.lost,q->total.recovered,q->c_tlost,q->c_trec);
        }
        fputc('\n',f);
    }
    int failed=fflush(f);if(!failed)failed=fsync(fd);if(fclose(f))failed=1;
    if(!failed)rename(tmp,status_path);else unlink(tmp);
}

/* ---------- network setup ---------- */

static int tun_open(void) {
    int fd = open("/dev/net/tun", O_RDWR);
    if (fd < 0) { perror("/dev/net/tun"); return -1; }
    struct ifreq ifr; memset(&ifr, 0, sizeof ifr);
    ifr.ifr_flags = IFF_TUN | IFF_NO_PI;
    snprintf(ifr.ifr_name, sizeof ifr.ifr_name, "%s", tun_name);
    if (ioctl(fd, TUNSETIFF, &ifr) < 0) { perror("TUNSETIFF"); close(fd); return -1; }
    char cmd[256], a[INET_ADDRSTRLEN];
    inet_ntop(AF_INET, &srv_ip, a, sizeof a);
    snprintf(cmd, sizeof cmd, "ip addr replace %s/%d dev %s && ip link set dev %s mtu %d up",
             a, srv_prefix, tun_name, tun_name, tun_mtu);
    if (system(cmd) != 0) { fprintf(stderr, "failed: %s\n", cmd); close(fd); return -1; }
    return fd;
}

static int port_open(vport *p) {
    if (p->faketcp) {
        if (ftcp_open(&p->rx, p->port) < 0) { perror("raw socket (need root/CAP_NET_RAW)"); p->fd = -1; return -1; }
        p->fd = p->rx.fd;
        return 0;
    }
    p->fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (p->fd < 0) { perror("socket"); return -1; }
    struct sockaddr_in a = { .sin_family = AF_INET, .sin_addr.s_addr = INADDR_ANY,
                             .sin_port = htons(p->port) };
    int buf = 4 << 20;
    setsockopt(p->fd, SOL_SOCKET, SO_RCVBUF, &buf, sizeof buf);
    setsockopt(p->fd, SOL_SOCKET, SO_SNDBUF, &buf, sizeof buf);
    if (bind(p->fd, (struct sockaddr *)&a, sizeof a) < 0) { perror("bind"); close(p->fd); p->fd = -1; return -1; }
    return 0;
}

static int same_port(const vport *a, const vport *b) {
    return a->faketcp == b->faketcp && a->port == b->port && a->repeat == b->repeat &&
           a->fec_k == b->fec_k && a->fec_on == b->fec_on && a->autotune == b->autotune &&
           a->jitter == b->jitter;
}

static void port_close(vport *p) {
    if (p->fd >= 0) close(p->fd);
    p->fd = -1;
}

/* Live reload of the port lines and mtu written by the panel. Listeners whose
   settings are unchanged keep their socket; sessions on changed listeners are
   dropped and reconnect through the new profile. Returns 0 on success. */
static int apply_listeners(vuser **list, int count) {
    if (next_mtu != tun_mtu) {
        char cmd[128];
        snprintf(cmd, sizeof cmd, "ip link set dev %s mtu %d", tun_name, next_mtu);
        if (system(cmd) != 0) { fprintf(stderr, "[kanki] failed: %s\n", cmd); return -1; }
        tun_mtu = next_mtu;
        fprintf(stderr, "[kanki] mtu %d\n", tun_mtu);
    }
    if (!next_nports) { fprintf(stderr, "[kanki] reload without port lines ignored\n"); return -1; }
    int changed = next_nports != nports;
    for (int i = 0; !changed && i < nports; i++) changed = !same_port(&ports[i], &next_ports[i]);
    if (!changed) return 0;
    vport fresh[MAX_PORTS];
    int reused[MAX_PORTS] = {0};
    for (int i = 0; i < next_nports; i++) {
        fresh[i] = next_ports[i]; fresh[i].fd = -1;
        for (int j = 0; j < nports; j++)
            if (!reused[j] && same_port(&ports[j], &fresh[i])) { fresh[i] = ports[j]; reused[j] = 1; break; }
        if (fresh[i].fd < 0 && port_open(&fresh[i]) != 0) {
            fprintf(stderr, "[kanki] cannot open %s port %d; keeping previous listeners\n",
                    fresh[i].faketcp ? "faketcp" : "udp", fresh[i].port);
            for (int k = 0; k <= i; k++) {
                int kept = 0;
                for (int j = 0; j < nports; j++) if (ports[j].fd == fresh[k].fd) kept = 1;
                if (!kept) port_close(&fresh[k]);
            }
            return -1;
        }
    }
    /* sessions keep a pointer to their listener: rebind them to the new table */
    for (int u = 0; u < count; u++) {
        vuser *v = list[u];
        if (!v->bound) continue;
        int moved = -1;
        for (int j = 0; j < nports; j++) if (v->port == &ports[j] && reused[j]) moved = j;
        if (moved < 0) { v->bound = 0; v->port = NULL; continue; }
        for (int i = 0; i < next_nports; i++) if (fresh[i].fd == ports[moved].fd) v->port = &ports[i];
    }
    for (int j = 0; j < nports; j++) if (!reused[j]) port_close(&ports[j]);
    memcpy(ports, fresh, sizeof fresh);
    nports = next_nports;
    for (int i = 0; i < nports; i++)
        fprintf(stderr, "[kanki] %s port %d: repeat=%d fec=%s(k=%d) jitter=%dus autotune=%d\n",
                ports[i].faketcp ? "faketcp" : "udp", ports[i].port, ports[i].repeat,
                ports[i].fec_on ? "on" : "off", ports[i].fec_k, ports[i].jitter, ports[i].autotune);
    return 0;
}

/* ---------- sessions ---------- */

static int user_links(vuser *u) {
    if (u->up) return 0;
    u->up = calloc(1, sizeof *u->up);
    u->down = calloc(1, sizeof *u->down);
    u->q = calloc(1, sizeof *u->q);
    if (!u->up || !u->down || !u->q) {
        free(u->up); free(u->down); free(u->q); u->up = u->down = NULL; u->q = NULL; return -1;
    }
    u->q->c_rtt = -1;
    link_init(u->up, u->psk, DEFAULT_REPEAT, DEFAULT_FEC_K, 1);
    link_init(u->down, u->psk, DEFAULT_REPEAT, DEFAULT_FEC_K, 1);
    if(u->replay_floor)dedup_seen(&u->up->dedup,u->replay_floor);
    u->up->tx = u->down;          /* TUNE from the client adjusts what we send it */
    return 0;
}

/* apply the profile of the port the user talks to */
static void user_profile(vuser *u, vport *p) {
    kanki_link *d = u->down;
    link_fec_flush(d, p->fd, (struct sockaddr *)&u->addr, sizeof u->addr);
    d->cfg.repeat = p->repeat; d->cfg.fec_k = p->fec_k; d->cfg.fec_enabled = p->fec_on;
    d->cfg.jitter_us = p->jitter; d->autotune = p->autotune;
    u->up->cfg.repeat = p->repeat; u->up->autotune = p->autotune;
    d->ft = p->faketcp ? &u->ft : NULL;
}

static void user_bind(vuser *u, vport *p, const struct sockaddr_in *from, uint32_t local_ip,
                      int new_session) {
    int moved = !u->bound || u->port != p || memcmp(&u->addr, from, sizeof *from) != 0;
    if (!moved) return;
    char was[64], now_ep[64];
    endpoint_str(&u->addr, was, sizeof was); endpoint_str(from, now_ep, sizeof now_ep);
    time_t now = time(NULL);
    long gap = u->last_rx ? (long)(now - u->last_rx) : -1;
    if (!u->bound || new_session) {
        u->q->since = now;
        event_log(u, "connect", "from=%s port=%d silent=%lds", now_ep, p->port, gap);
    } else {
        u->q->roams++;
        event_log(u, "roam", "from=%s to=%s port=%d silent=%lds", was, now_ep, p->port, gap);
    }
    u->addr = *from;
    if (p->faketcp) {
        u->ft = p->rx;                         /* shares the raw fd and local port */
        u->ft.remote_ip = from->sin_addr.s_addr;
        u->ft.remote_port = ntohs(from->sin_port);
        u->ft.local_ip = local_ip;
        u->ft.pinned = 1;
    }
    if (u->port != p || !u->bound) { u->port = p; user_profile(u, p); }
    u->bound = 1;
}

/* answer "PING:<x>" with "PONG:<x>" (CONTROL, 10x, outside FEC) to whoever asked */
static void send_pong(vuser *u, vport *p, const struct sockaddr_in *to, uint32_t local_ip,
                      const kanki_pkt *ping) {
    uint8_t m[64];
    uint16_t n = ping->payload_len > sizeof m ? sizeof m : ping->payload_len;
    memcpy(m, ping->payload, n);
    memcpy(m, "PONG:", 5);
    kanki_link *d = u->down;
    ftcp_t tmp, *saved = d->ft;
    if (p->faketcp) {
        tmp = p->rx;
        tmp.remote_ip = to->sin_addr.s_addr; tmp.remote_port = ntohs(to->sin_port);
        tmp.local_ip = local_ip;
        d->ft = &tmp;
    } else d->ft = NULL;
    link_tx_copies(d, p->fd, (const struct sockaddr *)to, sizeof *to, FLAG_CONTROL,
                   d->cfg.tx_seq++, 0, 0, d->cfg.fec_k, m, n);
    d->ft = saved;
}

static int is_ping(const kanki_pkt *k) {
    return (k->flags & FLAG_CONTROL) && k->payload_len >= 5 && !memcmp(k->payload, "PING:", 5);
}

static int is_control(const kanki_pkt *k, const char *tag) {
    size_t n = strlen(tag);
    return (k->flags & FLAG_CONTROL) && k->payload_len >= n && !memcmp(k->payload, tag, n);
}

/* "STAT:v1 rtt=MS loss=PERMILLE lost=N rec=N hops=N" from the client (downlink) */
static void client_stat(vuser *u, const kanki_pkt *k) {
    char m[160]; size_t n = k->payload_len < sizeof m - 1 ? k->payload_len : sizeof m - 1;
    memcpy(m, k->payload, n); m[n] = 0;
    int rtt; unsigned loss, hops; unsigned long long lost, rec;
    if (sscanf(m, "STAT:v1 rtt=%d loss=%u lost=%llu rec=%llu hops=%u", &rtt, &loss, &lost, &rec, &hops) != 5) return;
    qstat *q = u->q;
    q->c_rtt = rtt < -1 ? -1 : (rtt > 60000 ? 60000 : rtt);
    q->c_loss_pm = loss > 1000 ? 1000 : loss;
    q->c_lost = lost; q->c_rec = rec; q->c_hops = hops;
    q->c_tlost += lost; q->c_trec += rec; q->c_at = time(NULL);
}

/* uplink quality back to the client, so the app can show both directions */
static void send_qual(vuser *u, time_t now) {
    qstat *q = u->q;
    if (!q || !u->bound || now - q->qual_at < QUAL_REPORT_S) return;
    q->qual_at = now;
    char m[96];
    int n = snprintf(m, sizeof m, "QUAL:v1 loss=%u lost=%" PRIu64 " rec=%" PRIu64 " repeat=%d",
                     q_loss_pm(&q->win), q->win.lost, q->win.recovered, u->down->cfg.repeat);
    link_send(u->down, u->port->fd, (struct sockaddr *)&u->addr, sizeof u->addr, FLAG_CONTROL,
              (const uint8_t *)m, (uint16_t)n);
}

/* deliver one decrypted packet coming from user u */
static void user_deliver(vuser *u, int tun, const kanki_pkt *k) {
    if(k->seq<=u->replay_floor)return;
    if (k->flags & FLAG_TAIL) { u->bound=0; event_log(u, "disconnect", "by=client"); return; }
    if (is_ping(k)) {
        send_pong(u, u->port, &u->addr, u->ft.local_ip, k);
        return;
    }
    if (is_control(k, "STAT:")) { client_stat(u, k); return; }
    if (!(k->flags & FLAG_DATA) || !within_quota(u) || !kanki_ipv4_valid(k->payload,k->payload_len,tun_mtu)) return;
    const uint8_t *ip = k->payload;
    uint32_t src;
    memcpy(&src, ip + 12, 4);
    if ((ip[0] >> 4) != 4 || src != u->ip) return;     /* only its own tunnel IP */
    if (!debit_packet(u,k->payload_len)) return;
    if (write(tun, ip, k->payload_len) == k->payload_len) {
        u->account->tx += k->payload_len; u->q->tx_bytes += k->payload_len;
    }
}

/* one wire packet arrived on port p from `from` */
static void port_in(vport *p, int tun, const uint8_t *buf, int n,
                    const struct sockaddr_in *from, uint32_t local_ip) {
    time_t now = time(NULL);
    /* fast path: the user already bound to this address */
    for (int i = 0; i < nusers; i++) {
        vuser *u = users[i];
        if (!u->bound || u->port != p || u->addr.sin_addr.s_addr != from->sin_addr.s_addr ||
            u->addr.sin_port != from->sin_port) continue;
        if (!within_quota(u)) continue;
        kanki_pkt k;
        if (kanki_open2(&u->up->cfg, buf, n, &k) != 0) continue;
        if(k.seq<=u->replay_floor && k.fec_idx!=FEC_PARITY_IDX)return;
        int sender_repeat = u->up->cfg.repeat;
        q_copy(u->q, &k, sender_repeat);
        int r = link_recv(u->up, buf, n, &k);
        if(r)u->last_rx = now;
        while (r) {
            if (r == 2) q_recovered(u->q, &k, sender_repeat);
            user_deliver(u, tun, &k);
            r = link_recv_stashed(u->up, &k);
        }
        if (u->up->pending_tune)
            link_send_tune(u->up, p->fd, (struct sockaddr *)&u->addr, sizeof u->addr);
        return;
    }
    /* unknown address: find whose key opens it */
    for (int i = 0; i < nusers; i++) {
        vuser *u = users[i];
        if (!within_quota(u)) continue;
        kanki_pkt k;
        if (kanki_open2(&u->probe, buf, n, &k) != 0) continue;
        if(k.seq<=u->replay_floor && k.fec_idx!=FEC_PARITY_IDX)return;
        if (user_links(u) != 0) return;
        /* Roaming: mobile operators (CGNAT) move a flow to a new public port
           without notice. Follow the device at once, like WireGuard, when the
           packet is authentic AND newer than anything seen; a replayed or
           delayed copy can never move the session. Parity carries an XOR of
           sequence numbers, so it never moves the session either. */
        if (k.fec_idx == FEC_PARITY_IDX) return;
        if (u->up->dedup.top && k.seq <= u->up->dedup.top) return;
        if (!within_quota(u)) return;
        user_bind(u, p, from, local_ip, is_control(&k, "KANKI-HELLO"));
        port_in(p, tun, buf, n, from, local_ip);
        return;
    }
}

int main(int argc, char **argv) {
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--config") && i + 1 < argc) conf_path = argv[++i];
        else if (!strcmp(argv[i], "--check-config")) check_only=1;
        else if (!strcmp(argv[i], "--credit-ledger") && i+1<argc) credit_path=argv[++i];
        else if (!strcmp(argv[i], "--status-file") && i+1<argc) status_path=argv[++i];
        else if (!strcmp(argv[i], "--events-file") && i+1<argc) events_path=argv[++i];
        else { fprintf(stderr, "usage: kanki-vpnd [--config FILE] [--status-file FILE] [--events-file FILE] [--credit-ledger FILE] [--check-config]\n"); return 1; }
    }
    inet_pton(AF_INET, "10.66.0.1", &srv_ip);
    srv_mask = htonl(0xFFFF0000u);
    memset(ip_map, 0xFF, sizeof ip_map);

    static vuser *nu[MAX_USERS]; int n = 0;
    if (load_conf(0, nu, &n) != 0) return 1;
    if (!nports) { fprintf(stderr, "no 'port' lines in %s\n", conf_path); return 1; }
    if(check_only){for(int i=0;i<n;i++)user_free(nu[i]);puts("Configuration valid");return 0;}
    if(credit_path && credit_open(&credits,credit_path)){fprintf(stderr,"Cannot validate/lock durable credit journal\n");return 1;}
    restore_usage(nu,n);
    apply_users(nu, n);

    int tun = tun_open();
    if (tun < 0) return 1;
    fcntl(tun, F_SETFL, fcntl(tun, F_GETFL) | O_NONBLOCK);
    for (int i = 0; i < nports; i++) {
        if (port_open(&ports[i]) != 0) return 1;
        fprintf(stderr, "[kanki] %s port %d: repeat=%d fec=%s(k=%d) jitter=%dus autotune=%d\n",
                ports[i].faketcp ? "faketcp" : "udp", ports[i].port, ports[i].repeat,
                ports[i].fec_on ? "on" : "off", ports[i].fec_k, ports[i].jitter, ports[i].autotune);
    }
    struct sigaction sa = { .sa_handler = on_sig };
    sigaction(SIGINT, &sa, NULL); sigaction(SIGTERM, &sa, NULL); sigaction(SIGHUP, &sa, NULL);
    signal(SIGPIPE, SIG_IGN);
    fprintf(stderr, "[kanki] vpn up on %s %s/%d mtu %d\n", tun_name,
            inet_ntoa(*(struct in_addr *)&srv_ip), srv_prefix, tun_mtu);

    struct stat conf_stat={0}; stat(conf_path,&conf_stat);
    time_t last_check=0;
    uint8_t buf[KANKI_MAX_PKT];
    while (running) {
        time_t check_now=time(NULL);
        if(check_now!=last_check) {
            last_check=check_now;save_status();
            for(int i=0;i<nusers;i++){       /* log quota / expiry transitions of known devices */
                vuser *u=users[i];if(!u->q)continue;
                int st=(u->expires&&(uint64_t)check_now>=u->expires)?1:(!within_quota(u)?2:0);
                if(st!=u->limit_state){
                    event_log(u,st==1?"expired":st==2?"quota":"allowed",st==1&&u->expires==1?"reason=disabled":NULL);
                    u->limit_state=st;
                }
            }
            struct stat current;
            if(!stat(conf_path,&current) && (current.st_ino!=conf_stat.st_ino ||
                current.st_mtim.tv_sec!=conf_stat.st_mtim.tv_sec || current.st_mtim.tv_nsec!=conf_stat.st_mtim.tv_nsec)) {
                reload=1;conf_stat=current;
            }
        }
        if (reload) {
            reload = 0; n = 0;
            if (load_conf(1, nu, &n) == 0) { apply_users(nu, n); apply_listeners(users, nusers); }
        }
        fd_set rf; FD_ZERO(&rf); FD_SET(tun, &rf);
        int maxfd = tun;
        for (int i = 0; i < nports; i++) { FD_SET(ports[i].fd, &rf); if (ports[i].fd > maxfd) maxfd = ports[i].fd; }
        struct timeval tv = { .tv_sec = 0, .tv_usec = 200000 };
        for (int i = 0; i < nusers; i++) {
            if (!users[i]->bound) continue;
            struct timeval t = link_poll_tv(users[i]->down);
            if (t.tv_usec < tv.tv_usec) tv = t;
        }
        int sel = select(maxfd + 1, &rf, NULL, NULL, &tv);
        time_t now = time(NULL);
        for (int i = 0; i < nusers; i++) {            /* FEC idle flush + session expiry */
            vuser *u = users[i];
            if (!u->bound) continue;
            if (now - u->last_rx > SESSION_IDLE_S) {
                u->bound = 0;
                event_log(u, "idle", "silent=%ds", SESSION_IDLE_S);
                continue;
            }
            q_roll(u, now);
            send_qual(u, now);
            link_fec_idle(u->down, u->port->fd, (struct sockaddr *)&u->addr, sizeof u->addr);
        }
        if (sel <= 0) continue;

        if (FD_ISSET(tun, &rf)) {                     /* internet -> user */
            for (int burst = 0; burst < 64; burst++) {
                ssize_t len = read(tun, buf, KANKI_MAX_MTU);
                if (len <= 0) break;
                if (!kanki_ipv4_valid(buf,len,tun_mtu)) continue;
                uint32_t dst; memcpy(&dst, buf + 16, 4);
                if ((dst & srv_mask) != (srv_ip & srv_mask)) continue;
                int idx = ip_map[ntohl(dst) & 0xFFFF];
                if (idx < 0 || idx >= nusers) continue;
                vuser *u = users[idx];
                if (!u->bound || u->ip != dst || !within_quota(u)) continue;
                if (!debit_packet(u,(uint64_t)len)) continue;
                u->account->rx += (uint64_t)len; u->q->rx_bytes += (uint64_t)len;
                link_send(u->down, u->port->fd, (struct sockaddr *)&u->addr, sizeof u->addr,
                          FLAG_DATA, buf, (uint16_t)len);
            }
        }
        for (int i = 0; i < nports; i++) {           /* users -> internet */
            vport *p = &ports[i];
            if (!FD_ISSET(p->fd, &rf)) continue;
            if (p->faketcp) {
                uint32_t peer = 0, local = 0; uint16_t pport = 0;
                int len = ftcp_recv(&p->rx, buf, sizeof buf, &peer, &pport, &local);
                if (len <= 0) continue;
                struct sockaddr_in from = { .sin_family = AF_INET };
                from.sin_addr.s_addr = peer; from.sin_port = htons(pport);
                port_in(p, tun, buf, len, &from, local);
            } else {
                for (int burst = 0; burst < 64; burst++) {
                    struct sockaddr_in from; socklen_t fl = sizeof from;
                    ssize_t len = recvfrom(p->fd, buf, sizeof buf, MSG_DONTWAIT,
                                           (struct sockaddr *)&from, &fl);
                    if (len <= 0) break;
                    port_in(p, tun, buf, (int)len, &from, 0);
                }
            }
        }
    }
    for (int i = 0; i < nusers; i++) {               /* graceful tail to every client */
        vuser *u = users[i];
        if (u->bound)
            link_send(u->down, u->port->fd, (struct sockaddr *)&u->addr, sizeof u->addr,
                      FLAG_TAIL, NULL, 0);
    }
    save_status();
    close(tun);
    int failed=credits.failed;credit_close(&credits);
    return failed?1:0;
}

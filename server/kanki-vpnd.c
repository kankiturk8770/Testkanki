/* kanki-vpnd.c — multi-user KANKI VPN server: TUN device <-> kanki tunnel.
   Every user has its own PSK and may connect from several devices at once
   (limit=N); each device session gets its own tunnel IP from the pool.
   Every listening port is a profile (repeat / FEC / jitter / transport).
   Config: /etc/kanki/kanki.conf (written by kanki-panel)
     tun kanki0
     address 10.66.0.1/16          (prefix 16..24, pool = the rest of the net)
     mtu 1280
     dns 1.1.1.1,8.8.8.8
     stats /run/kanki/stats
     port udp 4000 name=Game repeat=3 fec_k=8 fec=1 autotune=1 jitter=0
     port faketcp 4443 name=FakeTCP repeat=4
     user NAME KEYHEX limit=2      (limit = max devices at once, 0 = no limit)
     deny NAME KEYHEX REASON       (expired / quota / disabled: client is told why)
   SIGHUP re-reads users / deny lines; sessions of unchanged users survive.

   Control messages (CONTROL flag, 10x):
     client -> server  HELLO:<devid 16 hex>:<wanted ip|0>   PING:<ts>[<devid>]   BYE
     server -> client  ADDR:<ip>/<prefix>:<mtu>:<dns,...>  PONG:<ts>   DENY:<reason>
                       RESET (live ping for a session the server no longer has)
   Stats (every 2 s, atomic rename):
     boot <unix>          user NAME RX TX           (bytes since boot)
     sess NAME IP PEER:PORT PROTO/PORT SINCE */
#define FEC_CACHE 4               /* ~210 KB per session instead of ~1.6 MB */
#include "kanki_link.h"
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

#define MAX_PORTS        8
#define MAX_USERS        65536
#define MAX_USER_SESS    32       /* hard cap per user even with limit=0 */
#define SESSION_IDLE_S   120      /* clients ping every second */
#define ADDR_HASH        4096
#define PING_SEEN        16
#define STATS_EVERY_S    2

typedef struct {
    int      faketcp;
    uint16_t port;
    int      repeat, fec_k, fec_on, autotune, jitter;
    int      fd;                  /* UDP socket or raw TCP socket */
    ftcp_t   rx;                  /* fake-TCP: receive side (unpinned) */
} vport;

struct vuser;
typedef struct vsess {
    struct vuser *u;
    uint8_t      devid[8];
    uint32_t     ip;              /* tunnel IP, network order */
    kanki_link  *up, *down;
    vport       *port;
    struct sockaddr_in addr;
    int          bound;           /* addr is valid and in the address hash */
    ftcp_t       ft;              /* fake-TCP send state towards this device */
    time_t       last_rx, since;
    int          flush_pending;   /* in flush[] (partial FEC block waiting) */
    struct vsess *hnext;          /* address hash chain */
} vsess;

typedef struct vuser {
    char      name[64];
    uint8_t   psk[32];
    int       limit;              /* max devices, 0 = MAX_USER_SESS */
    char      deny[24];           /* non-empty => refused with this reason */
    kanki_cfg probe;              /* key cache to recognise this user's packets */
    kanki_link *ctl;              /* tx link for PONG/DENY to unbound peers */
    vsess    *sess[MAX_USER_SESS];
    int       nsess;
    uint64_t  rx_bytes, tx_bytes; /* since daemon start */
    time_t    last_deny;
    uint64_t  ping_seen[PING_SEEN];
    int       ping_pos;
} vuser;

static volatile sig_atomic_t running = 1, reload = 0;
static void on_sig(int s) { if (s == SIGHUP) reload = 1; else running = 0; }

static const char *conf_path = "/etc/kanki/kanki.conf";
static char     tun_name[IFNAMSIZ] = "kanki0";
static char     stats_path[256] = "/run/kanki/stats";
static char     dns[128] = "1.1.1.1,8.8.8.8";
static uint32_t srv_ip, srv_mask;          /* network order */
static int      srv_prefix = 16, tun_mtu = 1280;
static vport    ports[MAX_PORTS];
static int      nports;
static vuser  **users;
static int      nusers;
static vsess   *ip_map[65536];             /* low 16 bits of tunnel IP -> session */
static vsess   *addr_hash[ADDR_HASH];
static vsess  **flush;                     /* sessions with a partial FEC block */
static int      nflush, flush_cap;
static uint32_t ip_cursor = 2;
static time_t   boot_time;

static int parse_psk(const char *hex, uint8_t psk[32]) {
    if (strlen(hex) != 64) return -1;
    for (int i = 0; i < 32; i++)
        if (sscanf(hex + 2 * i, "%2hhx", &psk[i]) != 1) return -1;
    return 0;
}

static int clampi(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

static const char *ip_str(uint32_t ip) {
    static char b[4][INET_ADDRSTRLEN]; static int i;
    i = (i + 1) & 3;
    inet_ntop(AF_INET, &ip, b[i], sizeof b[i]);
    return b[i];
}

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
        /* name= and other keys are for the panel / the subscription */
    }
    return 0;
}

static vuser *user_new(const char *name, const char *key) {
    vuser *u = calloc(1, sizeof *u);
    if (!u) return NULL;
    snprintf(u->name, sizeof u->name, "%s", name);
    if (parse_psk(key, u->psk) != 0) { free(u); return NULL; }
    kanki_init(&u->probe, u->psk, DEFAULT_REPEAT, DEFAULT_FEC_K, 1);
    return u;
}

/* read the config; with users_only just the user / deny lines (SIGHUP) */
static int load_conf(int users_only, vuser **out, int *nout) {
    FILE *f = fopen(conf_path, "r");
    if (!f) { perror(conf_path); return -1; }
    char line[1024]; int ln = 0, n = 0;
    while (fgets(line, sizeof line, f)) {
        ln++;
        char *s = line; while (isspace((unsigned char)*s)) s++;
        char *e = s + strlen(s); while (e > s && isspace((unsigned char)e[-1])) *--e = 0;
        if (!*s || *s == '#') continue;
        char *kw = strtok(s, " \t"), *rest = strtok(NULL, "");
        if (!rest) rest = "";
        if (!strcmp(kw, "user") || !strcmp(kw, "deny")) {
            char name[64], key[80], extra[64] = "";
            if (sscanf(rest, "%63s %79s %63s", name, key, extra) < 2) goto bad;
            if (n >= MAX_USERS) { fprintf(stderr, "too many users\n"); break; }
            vuser *u = user_new(name, key);
            if (!u) goto bad;
            if (kw[0] == 'd') snprintf(u->deny, sizeof u->deny, "%s", extra[0] ? extra : "disabled");
            else if (!strncmp(extra, "limit=", 6)) u->limit = clampi(atoi(extra + 6), 0, MAX_USER_SESS);
            out[n++] = u;
        } else if (users_only) {
            continue;
        } else if (!strcmp(kw, "tun")) {
            if (strlen(rest) >= IFNAMSIZ) goto bad;
            for (const char *c = rest; *c; c++) if (!isalnum((unsigned char)*c) && *c != '-' && *c != '_') goto bad;
            snprintf(tun_name, sizeof tun_name, "%s", rest);
        } else if (!strcmp(kw, "address")) {
            char a[32]; int pfx;
            if (sscanf(rest, "%31[0-9.]/%d", a, &pfx) != 2 || pfx < 16 || pfx > 24 ||
                inet_pton(AF_INET, a, &srv_ip) != 1) goto bad;
            srv_prefix = pfx;
            srv_mask = htonl(0xFFFFFFFFu << (32 - pfx));
        } else if (!strcmp(kw, "mtu")) {
            tun_mtu = clampi(atoi(rest), 576, KANKI_MAX_MTU);
        } else if (!strcmp(kw, "dns")) {
            for (const char *c = rest; *c; c++) if (!isdigit((unsigned char)*c) && *c != '.' && *c != ',') goto bad;
            snprintf(dns, sizeof dns, "%s", rest);
        } else if (!strcmp(kw, "stats")) {
            snprintf(stats_path, sizeof stats_path, "%s", rest);
        } else if (!strcmp(kw, "port")) {
            if (nports >= MAX_PORTS || parse_port(rest, &ports[nports]) != 0) goto bad;
            nports++;
        }   /* domain, ... : used by the panel only */
        continue;
    bad:
        fprintf(stderr, "%s:%d: bad line\n", conf_path, ln);
    }
    fclose(f);
    *nout = n;
    return 0;
}

/* ---------- address hash / flush list ---------- */

static unsigned addr_bucket(const struct sockaddr_in *a) {
    uint32_t h = a->sin_addr.s_addr * 2654435761u ^ (uint32_t)a->sin_port * 40503u;
    return (h ^ (h >> 15)) % ADDR_HASH;
}

static void hash_del(vsess *s) {
    if (!s->bound) return;
    vsess **pp = &addr_hash[addr_bucket(&s->addr)];
    while (*pp && *pp != s) pp = &(*pp)->hnext;
    if (*pp) *pp = s->hnext;
    s->hnext = NULL;
    s->bound = 0;
}

static vsess *hash_find(vport *p, const struct sockaddr_in *a) {
    for (vsess *s = addr_hash[addr_bucket(a)]; s; s = s->hnext)
        if (s->port == p && s->addr.sin_addr.s_addr == a->sin_addr.s_addr &&
            s->addr.sin_port == a->sin_port) return s;
    return NULL;
}

static void flush_mark(vsess *s) {
    if (s->flush_pending || !s->down->tx_idx) return;
    if (nflush == flush_cap) {
        int cap = flush_cap ? flush_cap * 2 : 256;
        vsess **nf = realloc(flush, (size_t)cap * sizeof *nf);
        if (!nf) return;
        flush = nf; flush_cap = cap;
    }
    flush[nflush++] = s;
    s->flush_pending = 1;
}

static void flush_unmark(vsess *s) {
    if (!s->flush_pending) return;
    for (int i = 0; i < nflush; i++)
        if (flush[i] == s) { flush[i] = flush[--nflush]; break; }
    s->flush_pending = 0;
}

/* ---------- sessions ---------- */

static void sess_free(vsess *s) {
    vuser *u = s->u;
    hash_del(s);
    flush_unmark(s);
    if (ip_map[ntohl(s->ip) & 0xFFFF] == s) ip_map[ntohl(s->ip) & 0xFFFF] = NULL;
    for (int i = 0; i < u->nsess; i++)
        if (u->sess[i] == s) { u->sess[i] = u->sess[--u->nsess]; break; }
    free(s->up); free(s->down); free(s);
}

static void user_free(vuser *u) {
    if (!u) return;
    while (u->nsess) sess_free(u->sess[0]);
    free(u->ctl); free(u);
}

static int ip_usable(uint32_t ip) {
    uint32_t h = ntohl(ip), net = ntohl(srv_ip & srv_mask), host = h & ~ntohl(srv_mask);
    return (ip & srv_mask) == (srv_ip & srv_mask) && ip != srv_ip &&
           host != 0 && host != ~ntohl(srv_mask) && h != net;
}

static uint32_t ip_alloc(uint32_t want) {
    if (want && ip_usable(want) && !ip_map[ntohl(want) & 0xFFFF]) return want;
    uint32_t hosts = ~ntohl(srv_mask) + 1u, net = ntohl(srv_ip & srv_mask);
    for (uint32_t i = 0; i < hosts; i++) {
        uint32_t ip = htonl(net + (ip_cursor++ % hosts));
        if (ip_usable(ip) && !ip_map[ntohl(ip) & 0xFFFF]) return ip;
    }
    return 0;
}

static vsess *sess_new(vuser *u, const uint8_t devid[8], uint32_t want) {
    if (u->nsess >= MAX_USER_SESS) return NULL;
    uint32_t ip = ip_alloc(want);
    if (!ip) { fprintf(stderr, "[kanki] address pool exhausted\n"); return NULL; }
    vsess *s = calloc(1, sizeof *s);
    if (!s) return NULL;
    s->up = calloc(1, sizeof *s->up);
    s->down = calloc(1, sizeof *s->down);
    if (!s->up || !s->down) { free(s->up); free(s->down); free(s); return NULL; }
    link_init(s->up, u->psk, DEFAULT_REPEAT, DEFAULT_FEC_K, 1);
    link_init(s->down, u->psk, DEFAULT_REPEAT, DEFAULT_FEC_K, 1);
    s->up->tx = s->down;          /* TUNE from the client adjusts what we send it */
    s->u = u;
    memcpy(s->devid, devid, 8);
    s->ip = ip;
    s->since = s->last_rx = time(NULL);
    ip_map[ntohl(ip) & 0xFFFF] = s;
    u->sess[u->nsess++] = s;
    return s;
}

/* apply the profile of the port the session talks to */
static void sess_profile(vsess *s, vport *p) {
    kanki_link *d = s->down;
    if (s->port) link_fec_flush(d, s->port->fd, (struct sockaddr *)&s->addr, sizeof s->addr);
    d->cfg.repeat = p->repeat; d->cfg.fec_k = p->fec_k; d->cfg.fec_enabled = p->fec_on;
    d->cfg.jitter_us = p->jitter; d->autotune = p->autotune;
    s->up->cfg.repeat = p->repeat; s->up->autotune = p->autotune;
    d->ft = p->faketcp ? &s->ft : NULL;
}

static void sess_bind(vsess *s, vport *p, const struct sockaddr_in *from, uint32_t local_ip) {
    if (s->bound && s->port == p && s->addr.sin_addr.s_addr == from->sin_addr.s_addr &&
        s->addr.sin_port == from->sin_port) return;
    vsess *other = hash_find(p, from);        /* another device had this address (NAT reuse) */
    if (other && other != s) hash_del(other);
    if (s->port != p) sess_profile(s, p);
    else if (s->bound) link_fec_flush(s->down, p->fd, (struct sockaddr *)&s->addr, sizeof s->addr);
    hash_del(s);
    s->addr = *from;
    s->port = p;
    if (p->faketcp) {
        s->ft = p->rx;                         /* shares the raw fd and local port */
        s->ft.remote_ip = from->sin_addr.s_addr;
        s->ft.remote_port = ntohs(from->sin_port);
        s->ft.local_ip = local_ip;
        s->ft.pinned = 1;
    }
    unsigned b = addr_bucket(from);
    s->hnext = addr_hash[b]; addr_hash[b] = s;
    s->bound = 1;
    fprintf(stderr, "[kanki] %s (%s) at %s:%d (%s %d)\n", s->u->name, ip_str(s->ip),
            inet_ntoa(from->sin_addr), ntohs(from->sin_port),
            p->faketcp ? "faketcp" : "udp", p->port);
}

/* CONTROL message straight to a peer address with link l (10x, outside FEC) */
static void ctl_send(kanki_link *l, vport *p, const struct sockaddr_in *to, uint32_t local_ip,
                     const char *msg, int n) {
    ftcp_t tmp, *saved = l->ft;
    if (p->faketcp) {
        tmp = p->rx;
        tmp.remote_ip = to->sin_addr.s_addr; tmp.remote_port = ntohs(to->sin_port);
        tmp.local_ip = local_ip;
        l->ft = &tmp;
    } else l->ft = NULL;
    l->cfg.jitter_us = 0;
    link_tx_copies(l, p->fd, (const struct sockaddr *)to, sizeof *to, FLAG_CONTROL,
                   l->cfg.tx_seq++, 0, 0, l->cfg.fec_k, (const uint8_t *)msg, (uint16_t)n);
    l->ft = saved;
}

static kanki_link *user_ctl(vuser *u) {
    if (!u->ctl && (u->ctl = calloc(1, sizeof *u->ctl)))
        link_init(u->ctl, u->psk, DEFAULT_REPEAT, DEFAULT_FEC_K, 0);
    return u->ctl;
}

static void send_ctl_to(vuser *u, vport *p, const struct sockaddr_in *to, uint32_t local_ip,
                        const char *msg, int n) {
    kanki_link *l = user_ctl(u);
    if (l) ctl_send(l, p, to, local_ip, msg, n);
}

static void send_deny(vuser *u, vport *p, const struct sockaddr_in *to, uint32_t local_ip,
                      const char *why) {
    time_t now = time(NULL);
    if (u->last_deny == now) return;           /* at most once a second */
    u->last_deny = now;
    char m[64];
    int n = snprintf(m, sizeof m, "DENY:%s", why);
    send_ctl_to(u, p, to, local_ip, m, n);
}

/* "PING:<x>" -> "PONG:<x>" */
static void pong_msg(const kanki_pkt *ping, char m[64], int *n) {
    *n = ping->payload_len > 64 ? 64 : ping->payload_len;
    memcpy(m, ping->payload, (size_t)*n);
    memcpy(m, "PONG:", 5);
}

static int is_ctl(const kanki_pkt *k, const char *pfx) {
    size_t l = strlen(pfx);
    return (k->flags & FLAG_CONTROL) && k->payload_len >= l && !memcmp(k->payload, pfx, l);
}

static int ping_dup(vuser *u, uint64_t seq) {
    for (int i = 0; i < PING_SEEN; i++) if (u->ping_seen[i] == seq) return 1;
    u->ping_seen[u->ping_pos++ % PING_SEEN] = seq;
    return 0;
}

/* HELLO:<16 hex devid>:<wanted ip> */
static int parse_hello(const kanki_pkt *k, uint8_t devid[8], uint32_t *want) {
    char m[64];
    int n = k->payload_len < 63 ? k->payload_len : 63;
    memcpy(m, k->payload, (size_t)n); m[n] = 0;
    char hex[17] = "", ip[20] = "";
    if (sscanf(m, "HELLO:%16[0-9a-fA-F]:%19[0-9.]", hex, ip) < 1 || strlen(hex) != 16) return -1;
    for (int i = 0; i < 8; i++) sscanf(hex + 2 * i, "%2hhx", &devid[i]);
    *want = 0;
    if (ip[0]) inet_pton(AF_INET, ip, want);
    return 0;
}

static void send_addr(vsess *s) {
    char m[200];
    int n = snprintf(m, sizeof m, "ADDR:%s/%d:%d:%s", ip_str(s->ip), srv_prefix, tun_mtu, dns);
    link_tx_copies(s->down, s->port->fd, (struct sockaddr *)&s->addr, sizeof s->addr,
                   FLAG_CONTROL, s->down->cfg.tx_seq++, 0, 0, s->down->cfg.fec_k,
                   (const uint8_t *)m, (uint16_t)n);
}

/* find or create the session of device devid; NULL + *why when refused */
static vsess *hello_session(vuser *u, const uint8_t devid[8], uint32_t want, const char **why) {
    for (int i = 0; i < u->nsess; i++)
        if (!memcmp(u->sess[i]->devid, devid, 8)) return u->sess[i];
    int limit = u->limit ? u->limit : MAX_USER_SESS;
    if (u->nsess >= limit) {
        /* a device that went quiet for 30 s is assumed gone: give its slot away */
        vsess *old = NULL; time_t now = time(NULL);
        for (int i = 0; i < u->nsess; i++)
            if (now - u->sess[i]->last_rx > 30 && (!old || u->sess[i]->last_rx < old->last_rx))
                old = u->sess[i];
        if (!old) { *why = "limit"; return NULL; }
        fprintf(stderr, "[kanki] %s: replacing idle device %s\n", u->name, ip_str(old->ip));
        sess_free(old);
    }
    vsess *s = sess_new(u, devid, want);
    if (!s) *why = "full";
    return s;
}

/* deliver one decrypted packet coming from session s */
static void sess_deliver(vsess *s, int tun, const kanki_pkt *k, const struct sockaddr_in *from,
                         uint32_t local_ip) {
    if (k->flags & FLAG_CONTROL) {
        if (is_ctl(k, "PING:")) {
            char m[64]; int n;
            pong_msg(k, m, &n);
            link_tx_copies(s->down, s->port->fd, (struct sockaddr *)&s->addr, sizeof s->addr,
                           FLAG_CONTROL, s->down->cfg.tx_seq++, 0, 0, s->down->cfg.fec_k,
                           (const uint8_t *)m, (uint16_t)n);
        } else if (is_ctl(k, "HELLO:")) {
            uint8_t devid[8]; uint32_t want;
            if (parse_hello(k, devid, &want) != 0) return;
            vsess *t = s;
            if (memcmp(devid, s->devid, 8) != 0) {    /* other device, same NAT address */
                const char *why = "full";
                vuser *u = s->u;
                if (!(t = hello_session(u, devid, want, &why))) {
                    send_deny(u, s->port, from, local_ip, why); return;
                }
                sess_bind(t, s->port, from, local_ip);
            }
            send_addr(t);
        } else if (is_ctl(k, "BYE")) {
            fprintf(stderr, "[kanki] %s (%s) disconnected\n", s->u->name, ip_str(s->ip));
            sess_free(s);
        }
        return;
    }
    if (!(k->flags & FLAG_DATA) || k->payload_len < 20) return;
    const uint8_t *ip = k->payload;
    uint32_t src;
    memcpy(&src, ip + 12, 4);
    if ((ip[0] >> 4) != 4 || src != s->ip) return;     /* only its own tunnel IP */
    if (write(tun, ip, k->payload_len) < 0 && errno != EAGAIN) perror("tun write");
    s->u->rx_bytes += k->payload_len;
}

/* run one decrypted packet through session s (dedup, FEC, delivery) */
static void sess_in(vsess *s, int tun, const kanki_pkt *k, const struct sockaddr_in *from,
                    uint32_t local_ip) {
    s->last_rx = time(NULL);
    kanki_pkt out;
    int r = link_recv_pkt(s->up, k, &out);
    while (r) {
        int bye = is_ctl(&out, "BYE");
        sess_deliver(s, tun, &out, from, local_ip);
        if (bye) return;                               /* s is gone */
        r = link_recv_stashed(s->up, &out);
    }
    if (s->up->pending_tune)
        link_send_tune(s->up, s->port->fd, (struct sockaddr *)&s->addr, sizeof s->addr);
}

/* one wire packet arrived on port p from `from` */
static void port_in(vport *p, int tun, const uint8_t *buf, int n,
                    const struct sockaddr_in *from, uint32_t local_ip) {
    kanki_pkt k;
    vsess *s = hash_find(p, from);                  /* fast path: known address */
    if (s && kanki_open2(&s->up->cfg, buf, n, &k) == 0) { sess_in(s, tun, &k, from, local_ip); return; }

    /* unknown address (new device, roaming, ping test): find whose key opens it */
    for (int i = 0; i < nusers; i++) {
        vuser *u = users[i];
        kanki_rx_refresh(&u->probe);
        if (buf[0] != u->probe.rx_keyid[0] && buf[0] != u->probe.rx_keyid[1] &&
            buf[0] != u->probe.rx_keyid[2]) continue;
        if (kanki_open2(&u->probe, buf, n, &k) != 0) continue;
        if (u->deny[0]) { send_deny(u, p, from, local_ip, u->deny); return; }
        vsess *t = NULL;
        if (is_ctl(&k, "PING:") && k.payload_len >= 21) {   /* live ping: carries the device id */
            for (int j = 0; j < u->nsess && !t; j++)
                if (!memcmp(u->sess[j]->devid, k.payload + 13, 8)) t = u->sess[j];
            if (!t) { if (!ping_dup(u, k.seq)) send_ctl_to(u, p, from, local_ip, "RESET", 5); return; }
        } else if (is_ctl(&k, "PING:")) {            /* ping test: answer, bind nothing */
            if (!ping_dup(u, k.seq)) {
                char m[64]; int mn;
                pong_msg(&k, m, &mn);
                send_ctl_to(u, p, from, local_ip, m, mn);
            }
            return;
        } else if (is_ctl(&k, "HELLO:")) {
            uint8_t devid[8]; uint32_t want; const char *why = "full";
            if (parse_hello(&k, devid, &want) != 0) return;
            if (!(t = hello_session(u, devid, want, &why))) { send_deny(u, p, from, local_ip, why); return; }
        } else if ((k.flags & FLAG_DATA) && k.payload_len >= 20) {
            uint32_t src; memcpy(&src, k.payload + 12, 4);    /* roaming: inner source IP */
            t = ip_map[ntohl(src) & 0xFFFF];
            if (!t || t->u != u || t->ip != src) return;
        } else if (u->nsess == 1) {
            t = u->sess[0];                                    /* only one device: it's that one */
        } else return;
        /* a replayed old packet must not move the session to the replayer */
        if (k.fec_idx != FEC_PARITY_IDX && dedup_peek(&t->up->dedup, k.seq)) return;
        sess_bind(t, p, from, local_ip);
        sess_in(t, tun, &k, from, local_ip);
        return;
    }
}

/* (re)build users[] keeping sessions of users whose key did not change */
static void apply_users(vuser **nu, int n) {
    for (int i = 0; i < n; i++) {
        for (int j = 0; j < nusers; j++) {
            vuser *o = users[j];
            if (!o || strcmp(o->name, nu[i]->name)) continue;
            /* traffic counters follow the name (the panel accounts by name) */
            nu[i]->rx_bytes = o->rx_bytes; nu[i]->tx_bytes = o->tx_bytes;
            if (!memcmp(o->psk, nu[i]->psk, 32) && !nu[i]->deny[0]) {
                o->limit = nu[i]->limit; o->deny[0] = 0;
                free(nu[i]); nu[i] = o; users[j] = NULL;
            }
            break;
        }
    }
    for (int j = 0; j < nusers; j++) user_free(users[j]);
    int active = 0, sess = 0;
    for (int i = 0; i < n; i++) {
        users[i] = nu[i];
        if (!nu[i]->deny[0]) active++;
        for (int k = 0; k < nu[i]->nsess; k++) nu[i]->sess[k]->u = nu[i];
        sess += nu[i]->nsess;
    }
    nusers = n;
    fprintf(stderr, "[kanki] %d user(s) loaded (%d active), %d session(s) kept\n", n, active, sess);
}

/* ---------- stats for the panel ---------- */

static void write_stats(void) {
    char tmp[300];
    snprintf(tmp, sizeof tmp, "%s.tmp", stats_path);
    FILE *f = fopen(tmp, "w");
    if (!f) return;
    fprintf(f, "boot %ld\ntime %ld\n", (long)boot_time, (long)time(NULL));
    for (int i = 0; i < nusers; i++) {
        vuser *u = users[i];
        if (u->rx_bytes || u->tx_bytes)
            fprintf(f, "user %s %llu %llu\n", u->name,
                    (unsigned long long)u->rx_bytes, (unsigned long long)u->tx_bytes);
        for (int k = 0; k < u->nsess; k++) {
            vsess *s = u->sess[k];
            fprintf(f, "sess %s %s %s:%d %s/%d %ld\n", u->name, ip_str(s->ip),
                    s->bound ? inet_ntoa(s->addr.sin_addr) : "-", s->bound ? ntohs(s->addr.sin_port) : 0,
                    s->port && s->port->faketcp ? "faketcp" : "udp", s->port ? s->port->port : 0,
                    (long)s->since);
        }
    }
    if (fclose(f) == 0) rename(tmp, stats_path);
}

/* ---------- network setup ---------- */

static int tun_open(void) {
    int fd = open("/dev/net/tun", O_RDWR);
    if (fd < 0) { perror("/dev/net/tun"); return -1; }
    struct ifreq ifr; memset(&ifr, 0, sizeof ifr);
    ifr.ifr_flags = IFF_TUN | IFF_NO_PI;
    snprintf(ifr.ifr_name, sizeof ifr.ifr_name, "%s", tun_name);
    if (ioctl(fd, TUNSETIFF, &ifr) < 0) { perror("TUNSETIFF"); close(fd); return -1; }
    /* address / mask / mtu / up via ioctl: no dependency on iproute2 */
    int s = socket(AF_INET, SOCK_DGRAM, 0);
    struct sockaddr_in *sa = (struct sockaddr_in *)&ifr.ifr_addr;
    int ok = s >= 0;
    memset(&ifr.ifr_ifru, 0, sizeof ifr.ifr_ifru);
    sa->sin_family = AF_INET; sa->sin_addr.s_addr = srv_ip;
    ok = ok && ioctl(s, SIOCSIFADDR, &ifr) == 0;
    sa->sin_family = AF_INET; sa->sin_addr.s_addr = srv_mask;
    ok = ok && ioctl(s, SIOCSIFNETMASK, &ifr) == 0;
    ifr.ifr_mtu = tun_mtu;
    ok = ok && ioctl(s, SIOCSIFMTU, &ifr) == 0;
    ok = ok && ioctl(s, SIOCGIFFLAGS, &ifr) == 0;
    ifr.ifr_flags |= IFF_UP | IFF_RUNNING;
    ok = ok && ioctl(s, SIOCSIFFLAGS, &ifr) == 0;
    if (s >= 0) close(s);
    if (!ok) { perror("configure tun"); close(fd); return -1; }
    return fd;
}

static int port_open(vport *p) {
    if (p->faketcp) {
        if (ftcp_open(&p->rx, p->port) < 0) { perror("raw socket (need root/CAP_NET_RAW)"); return -1; }
        p->fd = p->rx.fd;
        return 0;
    }
    p->fd = socket(AF_INET, SOCK_DGRAM, 0);
    struct sockaddr_in a = { .sin_family = AF_INET, .sin_addr.s_addr = INADDR_ANY,
                             .sin_port = htons(p->port) };
    int buf = 8 << 20;
    setsockopt(p->fd, SOL_SOCKET, SO_RCVBUF, &buf, sizeof buf);
    setsockopt(p->fd, SOL_SOCKET, SO_SNDBUF, &buf, sizeof buf);
    if (bind(p->fd, (struct sockaddr *)&a, sizeof a) < 0) { perror("bind"); return -1; }
    return 0;
}

int main(int argc, char **argv) {
    const char *pidfile = NULL;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--config") && i + 1 < argc) conf_path = argv[++i];
        else if (!strcmp(argv[i], "--pidfile") && i + 1 < argc) pidfile = argv[++i];
        else { fprintf(stderr, "usage: kanki-vpnd [--config /etc/kanki/kanki.conf] [--pidfile FILE]\n"); return 1; }
    }
    setvbuf(stderr, NULL, _IOLBF, 0);
    inet_pton(AF_INET, "10.66.0.1", &srv_ip);
    srv_mask = htonl(0xFFFF0000u);
    boot_time = time(NULL);
    srand((unsigned)boot_time ^ (unsigned)getpid());

    users = calloc(MAX_USERS, sizeof *users);
    vuser **nu = calloc(MAX_USERS, sizeof *nu);
    if (!users || !nu) return 1;
    int n = 0;
    if (load_conf(0, nu, &n) != 0) return 1;
    if (!nports) { fprintf(stderr, "no 'port' lines in %s\n", conf_path); return 1; }
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
    if (pidfile) { FILE *f = fopen(pidfile, "w"); if (f) { fprintf(f, "%d\n", (int)getpid()); fclose(f); } }
    struct sigaction sa = { .sa_handler = on_sig };
    sigaction(SIGINT, &sa, NULL); sigaction(SIGTERM, &sa, NULL); sigaction(SIGHUP, &sa, NULL);
    signal(SIGPIPE, SIG_IGN);
    fprintf(stderr, "[kanki] vpn up on %s %s/%d mtu %d\n", tun_name, ip_str(srv_ip), srv_prefix, tun_mtu);

    uint8_t buf[KANKI_MAX_PKT];
    time_t last_tick = 0, last_stats = 0;
    while (running) {
        if (reload) {
            reload = 0; n = 0;
            if (load_conf(1, nu, &n) == 0) apply_users(nu, n);
            last_stats = 0;
        }
        fd_set rf; FD_ZERO(&rf); FD_SET(tun, &rf);
        int maxfd = tun;
        for (int i = 0; i < nports; i++) { FD_SET(ports[i].fd, &rf); if (ports[i].fd > maxfd) maxfd = ports[i].fd; }
        struct timeval tv = { .tv_sec = 0, .tv_usec = 200000 };
        for (int i = 0; i < nflush; i++) {
            struct timeval t = link_poll_tv(flush[i]->down);
            if (t.tv_usec < tv.tv_usec) tv = t;
        }
        int sel = select(maxfd + 1, &rf, NULL, NULL, &tv);
        if (sel < 0 && errno != EINTR) { perror("select"); break; }

        for (int i = 0; i < nflush; ) {               /* FEC idle flush */
            vsess *s = flush[i];
            link_fec_idle(s->down, s->port->fd, (struct sockaddr *)&s->addr, sizeof s->addr);
            if (!s->down->tx_idx) { flush[i] = flush[--nflush]; s->flush_pending = 0; }
            else i++;
        }
        time_t now = time(NULL);
        if (now != last_tick) {                       /* once a second: session expiry */
            last_tick = now;
            for (int i = 0; i < nusers; i++)
                for (int k = 0; k < users[i]->nsess; ) {
                    vsess *s = users[i]->sess[k];
                    if (now - s->last_rx > SESSION_IDLE_S) {
                        fprintf(stderr, "[kanki] %s (%s) idle, session closed\n", s->u->name, ip_str(s->ip));
                        sess_free(s);                 /* swaps the last one into slot k */
                    } else k++;
                }
        }
        if (now - last_stats >= STATS_EVERY_S) { last_stats = now; write_stats(); }
        if (sel <= 0) continue;

        if (FD_ISSET(tun, &rf)) {                     /* internet -> device */
            for (int burst = 0; burst < 64; burst++) {
                ssize_t len = read(tun, buf, KANKI_MAX_MTU);
                if (len <= 0) break;
                if (len < 20 || (buf[0] >> 4) != 4) continue;
                uint32_t dst; memcpy(&dst, buf + 16, 4);
                if ((dst & srv_mask) != (srv_ip & srv_mask)) continue;
                vsess *s = ip_map[ntohl(dst) & 0xFFFF];
                if (!s || !s->bound || s->ip != dst) continue;
                link_send(s->down, s->port->fd, (struct sockaddr *)&s->addr, sizeof s->addr,
                          FLAG_DATA, buf, (uint16_t)len);
                s->u->tx_bytes += (uint64_t)len;
                flush_mark(s);
            }
        }
        for (int i = 0; i < nports; i++) {           /* devices -> internet */
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
    for (int i = 0; i < nusers; i++)                 /* graceful tail to every device */
        for (int k = 0; k < users[i]->nsess; k++) {
            vsess *s = users[i]->sess[k];
            if (s->bound)
                link_send(s->down, s->port->fd, (struct sockaddr *)&s->addr, sizeof s->addr,
                          FLAG_TAIL, NULL, 0);
        }
    write_stats();
    if (pidfile) unlink(pidfile);
    close(tun);
    return 0;
}

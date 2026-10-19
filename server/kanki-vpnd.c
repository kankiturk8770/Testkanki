/* kanki-vpnd.c — multi-user KANKI VPN server: TUN device <-> kanki tunnel.
   Every user has its own PSK and tunnel IP; every listening port is a
   profile (repeat / FEC / jitter / transport). Config: /etc/kanki/kanki.conf
     tun kanki0
     address 10.66.0.1/16
     mtu 1280
     port udp 4000 name=Game repeat=3 fec_k=8 fec=1 autotune=1 jitter=0
     port faketcp 4443 name=FakeTCP repeat=4
     user NAME KEYHEX 10.66.0.2 [TOKEN]
   SIGHUP re-reads the user list. */
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

#define MAX_PORTS      8
#define MAX_USERS      4096
#define SESSION_IDLE_S 300        /* unbind a user after 5 min of silence */
#define PING_SEEN      16

typedef struct {
    int      faketcp;
    uint16_t port;
    int      repeat, fec_k, fec_on, autotune, jitter;
    int      fd;                  /* UDP socket or raw TCP socket */
    ftcp_t   rx;                  /* fake-TCP: receive side (unpinned) */
} vport;

typedef struct {
    char        name[64];
    uint8_t     psk[32];
    uint32_t    ip;               /* tunnel IP, network order */
    kanki_cfg   probe;            /* key cache to recognise this user's packets */
    kanki_link *up, *down;        /* allocated on first contact */
    int         bound;
    vport      *port;
    struct sockaddr_in addr;
    ftcp_t      ft;               /* fake-TCP send state towards this user */
    time_t      last_rx;
    uint64_t    ping_seen[PING_SEEN];
    int         ping_pos;
} vuser;

static volatile sig_atomic_t running = 1, reload = 0;
static void on_sig(int s) { if (s == SIGHUP) reload = 1; else running = 0; }

static const char *conf_path = "/etc/kanki/kanki.conf";
static char     tun_name[IFNAMSIZ] = "kanki0";
static uint32_t srv_ip, srv_mask;          /* network order */
static int      srv_prefix = 16, tun_mtu = 1280;
static vport    ports[MAX_PORTS];
static int      nports;
static vuser   *users[MAX_USERS];
static int      nusers;
static int16_t  ip_map[65536];             /* low 16 bits of tunnel IP -> user index */

static int parse_psk(const char *hex, uint8_t psk[32]) {
    if (strlen(hex) != 64) return -1;
    for (int i = 0; i < 32; i++)
        if (sscanf(hex + 2 * i, "%2hhx", &psk[i]) != 1) return -1;
    return 0;
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

/* read the config; with users_only just the user list (SIGHUP) */
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
        if (!strcmp(kw, "user")) {
            char name[64], key[80], ip[32];
            if (sscanf(rest, "%63s %79s %31s", name, key, ip) != 3) goto bad;
            if (n >= MAX_USERS) { fprintf(stderr, "too many users\n"); break; }
            vuser *u = calloc(1, sizeof *u);
            snprintf(u->name, sizeof u->name, "%s", name);
            if (parse_psk(key, u->psk) != 0 || inet_pton(AF_INET, ip, &u->ip) != 1) { free(u); goto bad; }
            kanki_init(&u->probe, u->psk, DEFAULT_REPEAT, DEFAULT_FEC_K, 1);
            out[n++] = u;
        } else if (users_only) {
            continue;
        } else if (!strcmp(kw, "tun")) {
            if (strlen(rest) >= IFNAMSIZ) goto bad;
            for (const char *c = rest; *c; c++) if (!isalnum((unsigned char)*c) && *c != '-' && *c != '_') goto bad;
            snprintf(tun_name, sizeof tun_name, "%s", rest);
        } else if (!strcmp(kw, "address")) {
            char a[32]; int pfx;
            if (sscanf(rest, "%31[0-9.]/%d", a, &pfx) != 2 || pfx < 8 || pfx > 30 ||
                inet_pton(AF_INET, a, &srv_ip) != 1) goto bad;
            srv_prefix = pfx;
            srv_mask = htonl(0xFFFFFFFFu << (32 - pfx));
        } else if (!strcmp(kw, "mtu")) {
            tun_mtu = clampi(atoi(rest), 576, KANKI_MAX_MTU);
        } else if (!strcmp(kw, "port")) {
            if (nports >= MAX_PORTS || parse_port(rest, &ports[nports]) != 0) goto bad;
            nports++;
        }   /* domain, dns, ... : used by kanki-admin only */
        continue;
    bad:
        fprintf(stderr, "%s:%d: bad line\n", conf_path, ln);
    }
    fclose(f);
    *nout = n;
    return 0;
}

static void user_free(vuser *u) {
    if (!u) return;
    free(u->up); free(u->down); free(u);
}

/* (re)build users[] keeping live sessions of users whose key did not change */
static void apply_users(vuser **nu, int n) {
    for (int i = 0; i < n; i++) {
        for (int j = 0; j < nusers; j++) {
            vuser *o = users[j];
            if (o && !strcmp(o->name, nu[i]->name) && !memcmp(o->psk, nu[i]->psk, 32) &&
                o->ip == nu[i]->ip) {
                user_free(nu[i]); nu[i] = o; users[j] = NULL; break;
            }
        }
    }
    for (int j = 0; j < nusers; j++) user_free(users[j]);
    memset(ip_map, 0xFF, sizeof ip_map);
    for (int i = 0; i < n; i++) {
        users[i] = nu[i];
        uint32_t h = ntohl(users[i]->ip);
        if ((users[i]->ip & srv_mask) != (srv_ip & srv_mask) || users[i]->ip == srv_ip)
            fprintf(stderr, "[kanki] user %s: %s is outside the tunnel network, ignored\n",
                    users[i]->name, inet_ntoa(*(struct in_addr *)&users[i]->ip));
        else ip_map[h & 0xFFFF] = (int16_t)i;
    }
    nusers = n;
    fprintf(stderr, "[kanki] %d user(s) loaded\n", nusers);
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
        if (ftcp_open(&p->rx, p->port) < 0) { perror("raw socket (need root/CAP_NET_RAW)"); return -1; }
        p->fd = p->rx.fd;
        return 0;
    }
    p->fd = socket(AF_INET, SOCK_DGRAM, 0);
    struct sockaddr_in a = { .sin_family = AF_INET, .sin_addr.s_addr = INADDR_ANY,
                             .sin_port = htons(p->port) };
    int buf = 4 << 20;
    setsockopt(p->fd, SOL_SOCKET, SO_RCVBUF, &buf, sizeof buf);
    setsockopt(p->fd, SOL_SOCKET, SO_SNDBUF, &buf, sizeof buf);
    if (bind(p->fd, (struct sockaddr *)&a, sizeof a) < 0) { perror("bind"); return -1; }
    return 0;
}

/* ---------- sessions ---------- */

static int user_links(vuser *u) {
    if (u->up) return 0;
    u->up = calloc(1, sizeof *u->up);
    u->down = calloc(1, sizeof *u->down);
    if (!u->up || !u->down) { free(u->up); free(u->down); u->up = u->down = NULL; return -1; }
    link_init(u->up, u->psk, DEFAULT_REPEAT, DEFAULT_FEC_K, 1);
    link_init(u->down, u->psk, DEFAULT_REPEAT, DEFAULT_FEC_K, 1);
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

static void user_bind(vuser *u, vport *p, const struct sockaddr_in *from, uint32_t local_ip) {
    int moved = !u->bound || u->port != p || memcmp(&u->addr, from, sizeof *from) != 0;
    if (!moved) return;
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
    fprintf(stderr, "[kanki] %s connected from %s:%d (%s %d)\n", u->name,
            inet_ntoa(from->sin_addr), ntohs(from->sin_port),
            p->faketcp ? "faketcp" : "udp", p->port);
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

static int ping_dup(vuser *u, uint64_t seq) {
    for (int i = 0; i < PING_SEEN; i++) if (u->ping_seen[i] == seq) return 1;
    u->ping_seen[u->ping_pos++ % PING_SEEN] = seq;
    return 0;
}

/* deliver one decrypted packet coming from user u */
static void user_deliver(vuser *u, int tun, const kanki_pkt *k) {
    if (is_ping(k)) {
        send_pong(u, u->port, &u->addr, u->ft.local_ip, k);
        return;
    }
    if (!(k->flags & FLAG_DATA) || k->payload_len < 20) return;
    const uint8_t *ip = k->payload;
    uint32_t src;
    memcpy(&src, ip + 12, 4);
    if ((ip[0] >> 4) != 4 || src != u->ip) return;     /* only its own tunnel IP */
    if (write(tun, ip, k->payload_len) < 0 && errno != EAGAIN) perror("tun write");
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
        kanki_pkt k;
        if (kanki_open2(&u->up->cfg, buf, n, &k) != 0) continue;
        u->last_rx = now;
        int r = link_recv(u->up, buf, n, &k);
        while (r) { user_deliver(u, tun, &k); r = link_recv_stashed(u->up, &k); }
        if (u->up->pending_tune)
            link_send_tune(u->up, p->fd, (struct sockaddr *)&u->addr, sizeof u->addr);
        return;
    }
    /* unknown address: find whose key opens it */
    for (int i = 0; i < nusers; i++) {
        vuser *u = users[i];
        kanki_pkt k;
        if (kanki_open2(&u->probe, buf, n, &k) != 0) continue;
        if (user_links(u) != 0) return;
        if (is_ping(&k)) {                    /* ping test: answer, don't move the session */
            if (!ping_dup(u, k.seq)) send_pong(u, p, from, local_ip, &k);
            return;
        }
        user_bind(u, p, from, local_ip);
        port_in(p, tun, buf, n, from, local_ip);
        return;
    }
}

int main(int argc, char **argv) {
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--config") && i + 1 < argc) conf_path = argv[++i];
        else { fprintf(stderr, "usage: kanki-vpnd [--config /etc/kanki/kanki.conf]\n"); return 1; }
    }
    inet_pton(AF_INET, "10.66.0.1", &srv_ip);
    srv_mask = htonl(0xFFFF0000u);
    memset(ip_map, 0xFF, sizeof ip_map);

    static vuser *nu[MAX_USERS]; int n = 0;
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
    struct sigaction sa = { .sa_handler = on_sig };
    sigaction(SIGINT, &sa, NULL); sigaction(SIGTERM, &sa, NULL); sigaction(SIGHUP, &sa, NULL);
    signal(SIGPIPE, SIG_IGN);
    fprintf(stderr, "[kanki] vpn up on %s %s/%d mtu %d\n", tun_name,
            inet_ntoa(*(struct in_addr *)&srv_ip), srv_prefix, tun_mtu);

    uint8_t buf[KANKI_MAX_PKT];
    while (running) {
        if (reload) {
            reload = 0; n = 0;
            if (load_conf(1, nu, &n) == 0) apply_users(nu, n);
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
                fprintf(stderr, "[kanki] %s idle, session closed\n", u->name);
                continue;
            }
            link_fec_idle(u->down, u->port->fd, (struct sockaddr *)&u->addr, sizeof u->addr);
        }
        if (sel <= 0) continue;

        if (FD_ISSET(tun, &rf)) {                     /* internet -> user */
            for (int burst = 0; burst < 64; burst++) {
                ssize_t len = read(tun, buf, KANKI_MAX_MTU);
                if (len <= 0) break;
                if (len < 20 || (buf[0] >> 4) != 4) continue;
                uint32_t dst; memcpy(&dst, buf + 16, 4);
                if ((dst & srv_mask) != (srv_ip & srv_mask)) continue;
                int idx = ip_map[ntohl(dst) & 0xFFFF];
                if (idx < 0 || idx >= nusers) continue;
                vuser *u = users[idx];
                if (!u->bound || u->ip != dst) continue;
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
    close(tun);
    return 0;
}

/* kanki_vpnc.h — VPN client: TUN fd (Android VpnService / Linux tun) <-> kanki tunnel
   to kanki-vpnd. Flow:
     vpnc_open()   resolve + UDP socket (Android: protect(v->fd) right after)
     vpnc_hello()  HELLO -> ADDR (tunnel IP / mtu / dns given by the server) or DENY
     vpnc_run()    TUN <-> tunnel until stopped, denied or the server re-addresses us
     vpnc_close()
   Plus vpnc_ping(): a one-shot ping test that does not disturb a live session. */
#ifndef KANKI_VPNC_H
#define KANKI_VPNC_H
#include "kanki_link.h"
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <sys/select.h>

#define VPNC_PING_EVERY_US   1000000u     /* live ping over the tunnel */
#define VPNC_LOST_AFTER_US   4000000u     /* no PONG for 4 s -> "reconnecting" + HELLO */
#define VPNC_HELLO_EVERY_US  2000000u

enum { VPNC_IDLE = 0, VPNC_CONNECTING = 1, VPNC_CONNECTED = 2, VPNC_ERROR = -1 };
enum {                                   /* return codes */
    VPNC_OK = 0, VPNC_E_RESOLVE = -2, VPNC_E_TIMEOUT = -3, VPNC_E_DENIED = -4,
    VPNC_E_SOCKET = -5, VPNC_E_READDR = -6
};

typedef struct {
    char     server[256];
    uint16_t port;
    uint8_t  psk[32];
    int      repeat, fec_k, fec_on, autotune, jitter;
    uint8_t  devid[8];                    /* stable per device: one session per device */
} vpnc_cfg;

typedef struct {
    volatile int      state;              /* VPNC_* */
    volatile int      rtt_ms;             /* last tunnel ping, -1 = none */
    volatile uint64_t rx_bytes, tx_bytes;
    char              deny[32];           /* reason after VPNC_E_DENIED */
} vpnc_stats;

typedef struct {
    vpnc_cfg    cfg;
    int         fd;
    struct sockaddr_in srv;
    kanki_link *up, *down;
    uint32_t    ip;                       /* tunnel IP, network order (after hello) */
    int         prefix, mtu;
    char        dns[128];
} vpnc;

static int vpnc_resolve(const char *host, uint16_t port, struct sockaddr_in *out) {
    char p[8]; snprintf(p, sizeof p, "%u", port);
    struct addrinfo hints = { .ai_family = AF_INET, .ai_socktype = SOCK_DGRAM }, *ai;
    if (getaddrinfo(host, p, &hints, &ai) != 0) return -1;
    *out = *(struct sockaddr_in *)ai->ai_addr;
    freeaddrinfo(ai);
    return 0;
}

static kanki_link *vpnc_link(const vpnc_cfg *c, int fec_on) {
    kanki_link *l = calloc(1, sizeof *l);       /* ~800 KB: never on a thread stack */
    if (!l) return NULL;
    link_init(l, c->psk, c->repeat, c->fec_k, fec_on);
    l->autotune = c->autotune;
    l->cfg.jitter_us = c->jitter;
    return l;
}

/* "PING:" + 8-byte timestamp (µs, monotonic) [+ 8-byte device id] */
static int vpnc_ping_msg(uint8_t m[21], uint64_t t, const uint8_t *devid) {
    memcpy(m, "PING:", 5);
    for (int i = 0; i < 8; i++) m[5 + i] = (uint8_t)(t >> (8 * i));
    if (!devid) return 13;
    memcpy(m + 13, devid, 8);
    return 21;
}

/* RTT in µs if pkt is a PONG, else -1 */
static int64_t vpnc_pong_rtt(const kanki_pkt *k, uint64_t now) {
    if (!(k->flags & FLAG_CONTROL) || k->payload_len < 13 || memcmp(k->payload, "PONG:", 5)) return -1;
    uint64_t t = 0;
    for (int i = 0; i < 8; i++) t |= (uint64_t)k->payload[5 + i] << (8 * i);
    return t <= now ? (int64_t)(now - t) : -1;
}

static int vpnc_ctl_is(const kanki_pkt *k, const char *pfx) {
    size_t l = strlen(pfx);
    return (k->flags & FLAG_CONTROL) && k->payload_len >= l && !memcmp(k->payload, pfx, l);
}

static void vpnc_ctl_str(const kanki_pkt *k, size_t skip, char *out, size_t outlen) {
    size_t n = k->payload_len > skip ? k->payload_len - skip : 0;
    if (n >= outlen) n = outlen - 1;
    memcpy(out, k->payload + skip, n);
    out[n] = 0;
    for (size_t i = 0; i < n; i++) if ((unsigned char)out[i] < 32 || out[i] == 127) out[i] = '?';
}

/* ADDR:<ip>/<prefix>:<mtu>:<dns,...> */
static int vpnc_parse_addr(const kanki_pkt *k, uint32_t *ip, int *prefix, int *mtu, char *dns, size_t dnslen) {
    char m[200], a[20], d[128] = "";
    vpnc_ctl_str(k, 0, m, sizeof m);
    if (sscanf(m, "ADDR:%19[0-9.]/%d:%d:%127[0-9.,]", a, prefix, mtu, d) < 3) return -1;
    if (inet_pton(AF_INET, a, ip) != 1 || *prefix < 8 || *prefix > 30) return -1;
    if (*mtu < 576 || *mtu > KANKI_MAX_MTU) *mtu = 1280;
    snprintf(dns, dnslen, "%s", d);
    return 0;
}

static void vpnc_close(vpnc *v) {
    if (v->fd >= 0) close(v->fd);
    free(v->up); free(v->down);
    v->fd = -1; v->up = v->down = NULL;
}

static int vpnc_open(vpnc *v, const vpnc_cfg *c) {
    memset(v, 0, sizeof *v);
    v->cfg = *c; v->fd = -1;
    if (vpnc_resolve(c->server, c->port, &v->srv) != 0) return VPNC_E_RESOLVE;
    v->fd = socket(AF_INET, SOCK_DGRAM, 0);
    v->up = vpnc_link(c, c->fec_on);
    v->down = vpnc_link(c, 1);
    if (v->fd < 0 || !v->up || !v->down) { vpnc_close(v); return VPNC_E_SOCKET; }
    v->down->tx = v->up;              /* TUNE from the server adjusts what we send it */
    int buf = 4 << 20;
    setsockopt(v->fd, SOL_SOCKET, SO_RCVBUF, &buf, sizeof buf);
    setsockopt(v->fd, SOL_SOCKET, SO_SNDBUF, &buf, sizeof buf);
    fcntl(v->fd, F_SETFL, fcntl(v->fd, F_GETFL) | O_NONBLOCK);
    return VPNC_OK;
}

static void vpnc_send_hello(vpnc *v, uint32_t want) {
    char m[64], hex[17], ip[INET_ADDRSTRLEN] = "0";
    for (int i = 0; i < 8; i++) snprintf(hex + 2 * i, 3, "%02x", v->cfg.devid[i]);
    if (want) inet_ntop(AF_INET, &want, ip, sizeof ip);
    int n = snprintf(m, sizeof m, "HELLO:%s:%s", hex, ip);
    link_send(v->up, v->fd, (struct sockaddr *)&v->srv, sizeof v->srv, FLAG_CONTROL,
              (const uint8_t *)m, (uint16_t)n);
}

/* handshake: returns VPNC_OK with v->ip/prefix/mtu/dns set, VPNC_E_DENIED
   (st->deny = reason) or VPNC_E_TIMEOUT. want = previous tunnel IP or 0 */
static int vpnc_hello(vpnc *v, uint32_t want, int timeout_ms, volatile int *running, vpnc_stats *st) {
    uint64_t start = kanki_mono_us(), last = 0;
    uint8_t pkt[KANKI_MAX_PKT];
    st->state = VPNC_CONNECTING; st->deny[0] = 0;
    while (!running || *running) {
        uint64_t now = kanki_mono_us();
        if (now - start >= (uint64_t)timeout_ms * 1000u) return VPNC_E_TIMEOUT;
        if (now - last >= 700000u) { vpnc_send_hello(v, want); last = now; }
        fd_set rf; FD_ZERO(&rf); FD_SET(v->fd, &rf);
        struct timeval tv = link_poll_tv(v->up);
        if (tv.tv_usec > 100000) tv.tv_usec = 100000;
        int sel = select(v->fd + 1, &rf, NULL, NULL, &tv);
        link_fec_idle(v->up, v->fd, (struct sockaddr *)&v->srv, sizeof v->srv);
        if (sel <= 0) continue;
        ssize_t n;
        while ((n = recv(v->fd, pkt, sizeof pkt, 0)) > 0) {
            kanki_pkt k;
            int r = link_recv(v->down, pkt, (int)n, &k);
            while (r) {
                if (vpnc_ctl_is(&k, "ADDR:") &&
                    vpnc_parse_addr(&k, &v->ip, &v->prefix, &v->mtu, v->dns, sizeof v->dns) == 0)
                    return VPNC_OK;
                if (vpnc_ctl_is(&k, "DENY:")) {
                    vpnc_ctl_str(&k, 5, st->deny, sizeof st->deny);
                    st->state = VPNC_ERROR;
                    return VPNC_E_DENIED;
                }
                r = link_recv_stashed(v->down, &k);
            }
        }
    }
    return VPNC_E_TIMEOUT;
}

/* run until *running becomes 0 (VPNC_OK), the server refuses us (VPNC_E_DENIED)
   or hands out another tunnel IP after a restart (VPNC_E_READDR: rebuild the TUN) */
static int vpnc_run(vpnc *v, int tun, volatile int *running, vpnc_stats *st) {
    st->state = VPNC_CONNECTING; st->rtt_ms = -1;
    fcntl(tun, F_SETFL, fcntl(tun, F_GETFL) | O_NONBLOCK);
    const struct sockaddr *to = (const struct sockaddr *)&v->srv;
    socklen_t tolen = sizeof v->srv;
    uint64_t last_ping = 0, last_pong = kanki_mono_us(), last_hello = kanki_mono_us();
    uint8_t pkt[KANKI_MAX_PKT];
    int ret = VPNC_OK;

    while (*running) {
        uint64_t now = kanki_mono_us();
        if (now - last_ping >= VPNC_PING_EVERY_US) {
            uint8_t m[21];
            link_send(v->up, v->fd, to, tolen, FLAG_CONTROL, m, (uint16_t)vpnc_ping_msg(m, now, v->cfg.devid));
            last_ping = now;
        }
        if (now - last_pong > VPNC_LOST_AFTER_US) {
            st->state = VPNC_CONNECTING; st->rtt_ms = -1;
            if (now - last_hello >= VPNC_HELLO_EVERY_US) { vpnc_send_hello(v, v->ip); last_hello = now; }
        }

        fd_set rf; FD_ZERO(&rf); FD_SET(tun, &rf); FD_SET(v->fd, &rf);
        struct timeval tv = link_poll_tv(v->up);
        if (tv.tv_usec > 100000) tv.tv_usec = 100000;      /* keep ping cadence + stop latency */
        int sel = select((tun > v->fd ? tun : v->fd) + 1, &rf, NULL, NULL, &tv);
        link_fec_idle(v->up, v->fd, to, tolen);
        if (sel <= 0) continue;

        if (FD_ISSET(tun, &rf)) {                           /* device -> server */
            for (int b = 0; b < 64; b++) {
                ssize_t n = read(tun, pkt, KANKI_MAX_MTU);
                if (n <= 0) break;
                link_send(v->up, v->fd, to, tolen, FLAG_DATA, pkt, (uint16_t)n);
                st->tx_bytes += (uint64_t)n;
            }
        }
        if (FD_ISSET(v->fd, &rf)) {                         /* server -> device */
            for (int b = 0; b < 64 && ret == VPNC_OK; b++) {
                ssize_t n = recv(v->fd, pkt, sizeof pkt, 0);
                if (n <= 0) break;
                kanki_pkt k;
                int r = link_recv(v->down, pkt, (int)n, &k);
                while (r) {
                    if (k.flags & FLAG_DATA) {
                        if (write(tun, k.payload, k.payload_len) > 0) st->rx_bytes += k.payload_len;
                    } else if (vpnc_ctl_is(&k, "PONG:")) {
                        int64_t rtt = vpnc_pong_rtt(&k, kanki_mono_us());
                        if (rtt >= 0) {
                            st->rtt_ms = (int)((rtt + 500) / 1000);
                            st->state = VPNC_CONNECTED;
                            last_pong = kanki_mono_us();
                        }
                    } else if (vpnc_ctl_is(&k, "RESET")) {   /* server lost our session */
                        vpnc_send_hello(v, v->ip); last_hello = kanki_mono_us();
                    } else if (vpnc_ctl_is(&k, "ADDR:")) {
                        uint32_t ip; int pfx, mtu; char d[128];
                        if (vpnc_parse_addr(&k, &ip, &pfx, &mtu, d, sizeof d) == 0 && ip != v->ip) {
                            v->ip = ip; v->prefix = pfx; v->mtu = mtu;
                            snprintf(v->dns, sizeof v->dns, "%s", d);
                            ret = VPNC_E_READDR; break;
                        }
                    } else if (vpnc_ctl_is(&k, "DENY:")) {
                        vpnc_ctl_str(&k, 5, st->deny, sizeof st->deny);
                        ret = VPNC_E_DENIED; break;
                    }
                    r = link_recv_stashed(v->down, &k);
                }
                if (v->down->pending_tune) link_send_tune(v->down, v->fd, to, tolen);
            }
            if (ret != VPNC_OK) break;
        }
    }
    if (ret == VPNC_OK) {                 /* user stopped: free the device slot now */
        link_send(v->up, v->fd, to, tolen, FLAG_CONTROL, (const uint8_t *)"BYE", 3);
        link_send(v->up, v->fd, to, tolen, FLAG_TAIL, NULL, 0);
    }
    st->state = ret == VPNC_E_DENIED ? VPNC_ERROR : VPNC_IDLE;
    st->rtt_ms = -1;
    return ret;
}

/* ping test: best RTT (ms) of `tries` pings through the real tunnel protocol
   (also proves the key is right), -1 = no answer, -2 = can't resolve,
   -4 = server refuses this account (expired / quota / disabled) */
static int vpnc_ping(const vpnc_cfg *c, int tries, int timeout_ms) {
    struct sockaddr_in srv;
    if (vpnc_resolve(c->server, c->port, &srv) != 0) return -2;
    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    kanki_link *tx = vpnc_link(c, 0), *rx = vpnc_link(c, 1);
    if (fd < 0 || !tx || !rx) { free(tx); free(rx); if (fd >= 0) close(fd); return -1; }
    tx->cfg.jitter_us = 0;
    int best = -1;
    uint8_t pkt[KANKI_MAX_PKT];
    for (int t = 0; t < tries && best != -4; t++) {
        uint8_t m[21];
        uint64_t sent = kanki_mono_us();
        link_send(tx, fd, (struct sockaddr *)&srv, sizeof srv, FLAG_CONTROL, m,
                  (uint16_t)vpnc_ping_msg(m, sent, NULL));
        uint64_t deadline = sent + (uint64_t)timeout_ms * 1000u;
        int got = 0;
        while (!got) {
            uint64_t now = kanki_mono_us();
            if (now >= deadline) break;
            fd_set rf; FD_ZERO(&rf); FD_SET(fd, &rf);
            struct timeval tv = { .tv_sec = 0, .tv_usec = (long)(deadline - now) };
            if (tv.tv_usec >= 1000000) { tv.tv_sec = tv.tv_usec / 1000000; tv.tv_usec %= 1000000; }
            if (select(fd + 1, &rf, NULL, NULL, &tv) <= 0) break;
            ssize_t n = recv(fd, pkt, sizeof pkt, 0);
            if (n <= 0) continue;
            kanki_pkt k;
            if (!link_recv(rx, pkt, (int)n, &k)) continue;
            if (vpnc_ctl_is(&k, "DENY:")) { best = -4; break; }
            int64_t rtt = vpnc_pong_rtt(&k, kanki_mono_us());
            if (rtt < 0) continue;
            int ms = (int)((rtt + 500) / 1000);
            if (best < 0 || ms < best) best = ms;
            got = 1;
        }
    }
    close(fd); free(tx); free(rx);
    return best;
}

#endif /* KANKI_VPNC_H */

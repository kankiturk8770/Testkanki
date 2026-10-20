/* kanki_vpnc.h — VPN client: TUN fd (Android VpnService / Linux tun) <-> kanki tunnel
   to kanki-vpnd. Plus a one-shot ping test that does not disturb a live session. */
#ifndef KANKI_VPNC_H
#define KANKI_VPNC_H
#include "kanki_link.h"
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <sys/select.h>

#define VPNC_PING_EVERY_US   1000000u     /* live ping over the tunnel */
#define VPNC_LOST_AFTER_US   5000000u     /* no PONG for 5 s -> "reconnecting" */

enum { VPNC_IDLE = 0, VPNC_CONNECTING = 1, VPNC_CONNECTED = 2, VPNC_ERROR = -1 };

typedef struct {
    char     server[256];
    uint16_t port;
    uint8_t  psk[32];
    int      repeat, fec_k, fec_on, autotune, jitter;
} vpnc_cfg;

typedef struct {
    volatile int      state;              /* VPNC_* */
    volatile int      rtt_ms;             /* last tunnel ping, -1 = none */
    volatile uint64_t rx_bytes, tx_bytes;
} vpnc_stats;

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

/* "PING:" + 8-byte timestamp (µs, monotonic) */
static int vpnc_ping_msg(uint8_t m[13], uint64_t t) {
    memcpy(m, "PING:", 5);
    for (int i = 0; i < 8; i++) m[5 + i] = (uint8_t)(t >> (8 * i));
    return 13;
}

/* RTT in µs if pkt is a PONG, else -1 */
static int64_t vpnc_pong_rtt(const kanki_pkt *k, uint64_t now) {
    if (!(k->flags & FLAG_CONTROL) || k->payload_len < 13 || memcmp(k->payload, "PONG:", 5)) return -1;
    uint64_t t = 0;
    for (int i = 0; i < 8; i++) t |= (uint64_t)k->payload[5 + i] << (8 * i);
    return t <= now ? (int64_t)(now - t) : -1;
}

/* run until *running becomes 0. returns 0, or -1 if the server can't be resolved */
static int vpnc_run(const vpnc_cfg *c, int tun, volatile int *running, vpnc_stats *st) {
    struct sockaddr_in srv;
    st->state = VPNC_CONNECTING; st->rtt_ms = -1; st->rx_bytes = st->tx_bytes = 0;
    if (vpnc_resolve(c->server, c->port, &srv) != 0) { st->state = VPNC_ERROR; return -1; }
    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    kanki_link *up = vpnc_link(c, c->fec_on), *down = vpnc_link(c, 1);
    if (fd < 0 || !up || !down) { free(up); free(down); if (fd >= 0) close(fd); st->state = VPNC_ERROR; return -1; }
    if (connect(fd,(struct sockaddr *)&srv,sizeof srv)<0) {
        close(fd);free(up);free(down);st->state=VPNC_ERROR;return -1;
    }
    down->tx = up;                    /* TUNE from the server adjusts what we send it */
    int buf = 4 << 20;
    setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &buf, sizeof buf);
    setsockopt(fd, SOL_SOCKET, SO_SNDBUF, &buf, sizeof buf);
    fcntl(tun, F_SETFL, fcntl(tun, F_GETFL) | O_NONBLOCK);
    fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
    const struct sockaddr *to = (const struct sockaddr *)&srv;

    const char *hello = "KANKI-HELLO";
    link_send(up, fd, to, sizeof srv, FLAG_CONTROL, (const uint8_t *)hello, (uint16_t)strlen(hello));
    uint64_t last_ping = 0, last_pong = kanki_mono_us();
    uint8_t pkt[KANKI_MAX_PKT];

    while (*running) {
        uint64_t now = kanki_mono_us();
        if (now - last_ping >= VPNC_PING_EVERY_US) {
            uint8_t m[13];
            link_send(up, fd, to, sizeof srv, FLAG_CONTROL, m, (uint16_t)vpnc_ping_msg(m, now));
            last_ping = now;
        }
        if (now - last_pong > VPNC_LOST_AFTER_US) { st->state = VPNC_CONNECTING; st->rtt_ms = -1; }

        fd_set rf; FD_ZERO(&rf); FD_SET(tun, &rf); FD_SET(fd, &rf);
        struct timeval tv = link_poll_tv(up);
        if (tv.tv_usec > 100000) tv.tv_usec = 100000;      /* keep ping cadence + stop latency */
        int sel = select((tun > fd ? tun : fd) + 1, &rf, NULL, NULL, &tv);
        link_fec_idle(up, fd, to, sizeof srv);
        if (sel<0 && errno!=EINTR) { st->state=VPNC_ERROR;break; }
        if (sel <= 0) continue;

        if (FD_ISSET(tun, &rf)) {                           /* device -> server */
            for (int b = 0; b < 64; b++) {
                ssize_t n = read(tun, pkt, KANKI_MAX_MTU);
                if (n <= 0) break;
                if (!kanki_ipv4_valid(pkt,n,KANKI_MAX_MTU)) continue;
                link_send(up, fd, to, sizeof srv, FLAG_DATA, pkt, (uint16_t)n);
                st->tx_bytes += (uint64_t)n;
            }
        }
        if (FD_ISSET(fd, &rf)) {                            /* server -> device */
            for (int b = 0; b < 64; b++) {
                ssize_t n = recv(fd, pkt, sizeof pkt, 0);
                if (n <= 0) break;
                kanki_pkt k;
                int r = link_recv(down, pkt, (int)n, &k);
                while (r) {
                    if ((k.flags & FLAG_DATA) && kanki_ipv4_valid(k.payload,k.payload_len,KANKI_MAX_MTU)) {
                        if (write(tun, k.payload, k.payload_len) > 0) st->rx_bytes += k.payload_len;
                    } else {
                        int64_t rtt = vpnc_pong_rtt(&k, kanki_mono_us());
                        if (rtt >= 0) {
                            st->rtt_ms = (int)((rtt + 500) / 1000);
                            st->state = VPNC_CONNECTED;
                            last_pong = kanki_mono_us();
                        }
                    }
                    r = link_recv_stashed(down, &k);
                }
                if (down->pending_tune) link_send_tune(down, fd, to, sizeof srv);
            }
        }
    }
    /* graceful tail: multiplied 10x + FEC flush -> no lost last packet */
    link_send(up, fd, to, sizeof srv, FLAG_TAIL, NULL, 0);
    close(fd); free(up); free(down);
    st->state = VPNC_IDLE; st->rtt_ms = -1;
    return 0;
}

/* ping test: best RTT (ms) of `tries` pings through the real tunnel protocol
   (also proves the key is right), -1 = no answer, -2 = can't resolve */
static int vpnc_ping(const vpnc_cfg *c, int tries, int timeout_ms) {
    struct sockaddr_in srv;
    if (vpnc_resolve(c->server, c->port, &srv) != 0) return -2;
    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    kanki_link *tx = vpnc_link(c, 0), *rx = vpnc_link(c, 1);
    if (fd < 0 || !tx || !rx) { free(tx); free(rx); if (fd >= 0) close(fd); return -1; }
    if(connect(fd,(struct sockaddr*)&srv,sizeof srv)<0){close(fd);free(tx);free(rx);return -1;}
    tx->cfg.jitter_us = 0;
    int best = -1;
    uint8_t pkt[KANKI_MAX_PKT];
    for (int t = 0; t < tries; t++) {
        uint8_t m[13];
        uint64_t sent = kanki_mono_us();
        link_send(tx, fd, (struct sockaddr *)&srv, sizeof srv, FLAG_CONTROL, m,
                  (uint16_t)vpnc_ping_msg(m, sent));
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

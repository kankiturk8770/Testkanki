/* kanki-client.c — local UDP entry point -> kanki tunnel -> server (Android: same core via JNI) */
#include "kanki_link.h"
#include <arpa/inet.h>
#include <netdb.h>
#include <signal.h>
#include <sys/select.h>

static volatile int running = 1;
static void on_sig(int s) { (void)s; running = 0; }

static int parse_psk(const char *hex, uint8_t psk[32]) {
    if (strlen(hex) != 64) return -1;
    for (int i = 0; i < 32; i++)
        if (sscanf(hex + 2 * i, "%2hhx", &psk[i]) != 1) return -1;
    return 0;
}

int main(int argc, char **argv) {
    const char *listen_s = NULL, *server_s = NULL, *psk_hex = NULL;
    int repeat = DEFAULT_REPEAT, fec_k = DEFAULT_FEC_K, fec_on = 1, autotune = 0, faketcp = 0, jitter = 1500;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--listen") && i + 1 < argc) listen_s = argv[++i];
        else if (!strcmp(argv[i], "--server") && i + 1 < argc) server_s = argv[++i];
        else if (!strcmp(argv[i], "--key") && i + 1 < argc) psk_hex = argv[++i];
        else if (!strcmp(argv[i], "--repeat") && i + 1 < argc) repeat = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--fec-k") && i + 1 < argc) fec_k = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--no-fec")) fec_on = 0;
        else if (!strcmp(argv[i], "--autotune")) autotune = 1;
        else if (!strcmp(argv[i], "--faketcp")) faketcp = 1;
        else if (!strcmp(argv[i], "--jitter") && i + 1 < argc) jitter = atoi(argv[++i]);
    }
    if (!listen_s || !server_s || !psk_hex) {
        fprintf(stderr, "usage: kanki-client --listen 127.0.0.1:PORT --server HOST:PORT "
                        "--key 64HEX [--repeat 3..10] [--fec-k N] [--no-fec] [--autotune] [--faketcp] [--jitter US]\n");
        return 1;
    }
    uint8_t psk[32];
    if (parse_psk(psk_hex, psk) != 0) { fprintf(stderr, "bad key\n"); return 1; }

    char lhost[256] = "127.0.0.1", lport[16], shost[256], sport[16];
    const char *c = strrchr(listen_s, ':');
    if (c) { snprintf(lport, sizeof lport, "%s", c + 1);
             if (c != listen_s) snprintf(lhost, sizeof lhost, "%.*s", (int)(c - listen_s), listen_s); }
    else snprintf(lport, sizeof lport, "%s", listen_s);
    c = strrchr(server_s, ':');
    if (!c) { fprintf(stderr, "bad server\n"); return 1; }
    snprintf(sport, sizeof sport, "%s", c + 1);
    snprintf(shost, sizeof shost, "%.*s", (int)(c - server_s), server_s);

    struct addrinfo hints = { .ai_family = AF_INET, .ai_socktype = SOCK_DGRAM }, *ai;
    if (getaddrinfo(shost, sport, &hints, &ai) != 0) { perror("server"); return 1; }
    struct sockaddr_in server = *(struct sockaddr_in *)ai->ai_addr;
    freeaddrinfo(ai);

    /* one socket talks to the kanki server; a second serves the local app */
    int tfd = socket(AF_INET, SOCK_DGRAM, 0);
    int lfd = socket(AF_INET, SOCK_DGRAM, 0);
    struct sockaddr_in bind_addr = { .sin_family = AF_INET };
    bind_addr.sin_port = htons((uint16_t)atoi(lport));
    inet_pton(AF_INET, lhost, &bind_addr.sin_addr);
    if (bind(lfd, (struct sockaddr *)&bind_addr, sizeof bind_addr) < 0) { perror("bind"); return 1; }

    kanki_link up = {0}, down = {0};
    link_init(&up, psk, repeat, fec_k, fec_on);
    link_init(&down, psk, repeat, fec_k, fec_on);
    up.autotune = autotune; down.autotune = autotune;
    up.cfg.jitter_us = jitter; down.cfg.jitter_us = jitter;
    ftcp_t ft = {0};
    if (faketcp) {
        if (ftcp_open(&ft, 40000 + (getpid() % 20000)) < 0) { perror("raw socket (need root)"); return 1; }
        ft.local_ip = INADDR_ANY;
        ft.remote_ip = server.sin_addr.s_addr;
        ft.remote_port = ntohs(server.sin_port);
        up.ft = &ft;
        fprintf(stderr, "[kanki] fake-TCP mode (root)\n");
    }

    /* control handshake (10x, anti "first-packet loss") */
    const char *hello = "KANKI-HELLO";
    link_send(&up, tfd, (struct sockaddr *)&server, sizeof server, FLAG_CONTROL,
              (const uint8_t *)hello, strlen(hello));

    signal(SIGINT, on_sig); signal(SIGTERM, on_sig);
    fprintf(stderr, "[kanki] client %s:%s -> %s:%s  repeat=%d fec=%s(k=%d)\n",
            lhost, lport, shost, sport, up.cfg.repeat, fec_on ? "on" : "off", fec_k);

    struct sockaddr_in app = {0}; socklen_t alen = sizeof app; int have_app = 0;
    uint8_t buf[KANKI_MAX_PKT];
    int maxfd = (tfd > lfd ? tfd : lfd) + 1;
    while (running) {
        fd_set rf; FD_ZERO(&rf); FD_SET(tfd, &rf); FD_SET(lfd, &rf);
        struct timeval tv = { .tv_sec = 0, .tv_usec = 200000 };
        if (select(maxfd, &rf, NULL, NULL, &tv) <= 0) {
            link_fec_flush(&up, tfd, (struct sockaddr *)&server, sizeof server);
            continue;
        }
        if (FD_ISSET(lfd, &rf)) {                 /* from local app */
            struct sockaddr_in from; socklen_t flen = sizeof from;
            ssize_t n = recvfrom(lfd, buf, sizeof buf, 0, (struct sockaddr *)&from, &flen);
            if (n > 0) {
                if (!have_app) { app = from; alen = flen; have_app = 1; }
                link_send(&up, tfd, (struct sockaddr *)&server, sizeof server,
                          FLAG_DATA, buf, (uint16_t)n);
            }
        }
        if (FD_ISSET(tfd, &rf)) {                 /* from kanki server */
            ssize_t n = recvfrom(tfd, buf, sizeof buf, 0, NULL, NULL);
            if (n > 0 && have_app) {
                kanki_pkt pkt;
                if (link_recv(&down, buf, (int)n, &pkt) && (pkt.flags & FLAG_DATA))
                    sendto(lfd, pkt.payload, pkt.payload_len, 0,
                           (struct sockaddr *)&app, alen);
                if (down.pending_tune)
                    link_send_tune(&up, tfd, (struct sockaddr *)&server, sizeof server);
            }
        }
    }
    /* graceful tail: multiplied 10x + FEC flush -> no lost last packet */
    link_send(&up, tfd, (struct sockaddr *)&server, sizeof server, FLAG_TAIL, NULL, 0);
    close(tfd); close(lfd);
    return 0;
}

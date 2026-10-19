/* kanki-server.c — Linux server: decapsulate tunnel -> forward to target, and back */
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
    const char *listen_s = NULL, *target_s = NULL, *psk_hex = NULL;
    int repeat = DEFAULT_REPEAT, fec_k = DEFAULT_FEC_K, fec_on = 1, autotune = 0, faketcp = 0, jitter = 1500;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--listen") && i + 1 < argc) listen_s = argv[++i];
        else if (!strcmp(argv[i], "--target") && i + 1 < argc) target_s = argv[++i];
        else if (!strcmp(argv[i], "--key") && i + 1 < argc) psk_hex = argv[++i];
        else if (!strcmp(argv[i], "--repeat") && i + 1 < argc) repeat = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--fec-k") && i + 1 < argc) fec_k = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--no-fec")) fec_on = 0;
        else if (!strcmp(argv[i], "--autotune")) autotune = 1;
        else if (!strcmp(argv[i], "--faketcp")) faketcp = 1;
        else if (!strcmp(argv[i], "--faketcp2")) ; /* unused */
        else if (!strcmp(argv[i], "--jitter") && i + 1 < argc) jitter = atoi(argv[++i]);
    }
    if (!listen_s || !target_s || !psk_hex) {
        fprintf(stderr, "usage: kanki-server --listen :PORT --target HOST:PORT --key 64HEX "
                        "[--repeat 3..10] [--fec-k N] [--no-fec]\n");
        return 1;
    }
    uint8_t psk[32];
    if (parse_psk(psk_hex, psk) != 0) { fprintf(stderr, "bad key\n"); return 1; }

    char lport[16] = "0";
    const char *c = strrchr(listen_s, ':');
    if (c) snprintf(lport, sizeof lport, "%s", c + 1);

    char thost[256], tport[16];
    c = strrchr(target_s, ':');
    if (!c) { fprintf(stderr, "bad target\n"); return 1; }
    snprintf(tport, sizeof tport, "%s", c + 1);
    snprintf(thost, sizeof thost, "%.*s", (int)(c - target_s), target_s);

    struct addrinfo hints = { .ai_family = AF_INET, .ai_socktype = SOCK_DGRAM }, *ai;
    if (getaddrinfo(thost, tport, &hints, &ai) != 0) { perror("target"); return 1; }
    struct sockaddr_in target = *(struct sockaddr_in *)ai->ai_addr;
    freeaddrinfo(ai);

    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    struct sockaddr_in bind_addr = { .sin_family = AF_INET, .sin_addr.s_addr = INADDR_ANY };
    bind_addr.sin_port = htons((uint16_t)atoi(lport));
    if (bind(fd, (struct sockaddr *)&bind_addr, sizeof bind_addr) < 0) { perror("bind"); return 1; }

    kanki_link up = {0}, down = {0};   /* separate seq spaces per direction */
    link_init(&up, psk, repeat, fec_k, fec_on);
    link_init(&down, psk, repeat, fec_k, fec_on);
    up.autotune = autotune; down.autotune = autotune;
    up.cfg.jitter_us = jitter; down.cfg.jitter_us = jitter;
    ftcp_t ft = {0};
    if (faketcp) {
        if (ftcp_open(&ft, (uint16_t)atoi(lport)) < 0) { perror("raw socket (need root/CAP_NET_RAW)"); return 1; }
        ft.remote_port = ft.local_port;   /* peer uses same port convention */
        down.ft = &ft;
        fprintf(stderr, "[kanki] fake-TCP mode (root) on port %s\n", lport);
    }

    struct sockaddr_in client = {0}; socklen_t clen = sizeof client;
    int have_client = 0;

    signal(SIGINT, on_sig); signal(SIGTERM, on_sig);
    fprintf(stderr, "[kanki] server up on :%s -> %s:%s  repeat=%d fec=%s(k=%d)\n",
            lport, thost, tport, up.cfg.repeat, fec_on ? "on" : "off", fec_k);

    uint8_t buf[KANKI_MAX_PKT];
    while (running) {
        fd_set rf; FD_ZERO(&rf); FD_SET(fd, &rf);
        struct timeval tv = { .tv_sec = 0, .tv_usec = 200000 };
        if (select(fd + 1, &rf, NULL, NULL, &tv) <= 0) {
            link_fec_flush(&up, fd, (struct sockaddr *)&target, sizeof target); /* idle flush */
            if (have_client) link_fec_flush(&down, fd, (struct sockaddr *)&client, clen);
            continue;
        }
        struct sockaddr_in from; socklen_t flen = sizeof from;
        ssize_t n;
        if (faketcp) {
            /* RX pipeline (stealth): pull kanki wire pkts out of fake TCP segments */
            uint32_t peer = 0;
            n = ftcp_recv(&ft, buf, sizeof buf, &peer);
            if (n <= 0) continue;
            if (!have_client && peer) {
                ft.remote_ip = peer;              /* learned from first packet */
                ft.local_ip  = 0;                 /* kernel fills src IP */
                memset(&from, 0, sizeof from);
                from.sin_family = AF_INET;
                from.sin_addr.s_addr = peer;
                from.sin_port = htons(ft.remote_port);
                flen = sizeof from;
            } else if (!have_client) continue;
            else {
                from = client; flen = clen;       /* attribute to bound client */
            }
        } else {
            n = recvfrom(fd, buf, sizeof buf, 0, (struct sockaddr *)&from, &flen);
            if (n <= 0) continue;
        }

        kanki_pkt pkt;
        int r = link_recv(&up, buf, (int)n, &pkt);
        if (r) {
            /* valid kanki packet -> from client */
            if (!have_client || memcmp(&from, &client, sizeof from) != 0) {
                client = from; clen = flen; have_client = 1;
                fprintf(stderr, "[kanki] client bound: %s:%d\n",
                        inet_ntoa(from.sin_addr), ntohs(from.sin_port));
            }
            if (pkt.flags & FLAG_DATA)
                sendto(fd, pkt.payload, pkt.payload_len, 0, (struct sockaddr *)&target, sizeof target);
            if (up.pending_tune)
                link_send_tune(&down, fd, (struct sockaddr *)&client, clen);
        } else if (have_client && from.sin_addr.s_addr == target.sin_addr.s_addr &&
                   from.sin_port == target.sin_port) {
            /* plain UDP reply from target -> encapsulate back to client */
            link_send(&down, fd, (struct sockaddr *)&client, clen, FLAG_DATA, buf, (uint16_t)n);
        }
    }
    close(fd);
    return 0;
}

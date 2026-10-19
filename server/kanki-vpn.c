/* kanki-vpn.c — Linux VPN client for kanki-vpnd (root: creates a TUN device).
     kanki-vpn 'kanki://KEYHEX@host:4000?repeat=3&fec=1&fec_k=8&autotune=1&jitter=0#Name'
              [--tun kanki1] [--devid 16hex] [--route-all] [--ping]
   --route-all  send all traffic through the tunnel (keeps a /32 route to the server)
   --ping       just measure the tunnel ping and exit */
#include "kanki_vpnc.h"
#include <ctype.h>
#include <linux/if_tun.h>
#include <net/if.h>
#include <signal.h>
#include <sys/ioctl.h>

static volatile int running = 1;
static void on_sig(int s) { (void)s; running = 0; }

static int hexval(int c) {
    return isdigit(c) ? c - '0' : (c >= 'a' && c <= 'f') ? c - 'a' + 10 : (c >= 'A' && c <= 'F') ? c - 'A' + 10 : -1;
}

/* kanki://KEY@host:port?k=v&...#name -> cfg; returns 0 */
static int parse_link(const char *link, vpnc_cfg *c, char *type, size_t tlen) {
    if (strncmp(link, "kanki://", 8)) return -1;
    const char *p = link + 8, *at = strchr(p, '@');
    if (!at || at - p != 64) return -1;
    for (int i = 0; i < 32; i++) {
        int h = hexval(p[2 * i]), l = hexval(p[2 * i + 1]);
        if (h < 0 || l < 0) return -1;
        c->psk[i] = (uint8_t)(h << 4 | l);
    }
    p = at + 1;
    size_t hl = strcspn(p, ":?#");
    if (!hl || hl >= sizeof c->server || p[hl] != ':') return -1;
    memcpy(c->server, p, hl); c->server[hl] = 0;
    if (c->server[0] == '[') return -1;                   /* IPv6 not supported */
    c->port = (uint16_t)atoi(p + hl + 1);
    if (!c->port) return -1;
    c->repeat = DEFAULT_REPEAT; c->fec_k = DEFAULT_FEC_K; c->fec_on = 1; c->autotune = 1; c->jitter = 0;
    snprintf(type, tlen, "udp");
    const char *q = strchr(p, '?');
    while (q && *q && *q != '#') {
        q++;
        char k[32] = "", v[32] = "";
        sscanf(q, "%31[^=&#]=%31[^&#]", k, v);
        if (!strcmp(k, "repeat")) c->repeat = atoi(v);
        else if (!strcmp(k, "fec")) c->fec_on = atoi(v) != 0;
        else if (!strcmp(k, "fec_k")) c->fec_k = atoi(v);
        else if (!strcmp(k, "autotune")) c->autotune = atoi(v) != 0;
        else if (!strcmp(k, "jitter")) c->jitter = atoi(v);
        else if (!strcmp(k, "type")) snprintf(type, tlen, "%s", v);
        q = strpbrk(q, "&#");
    }
    return 0;
}

static int tun_create(const char *name, char *out) {
    int fd = open("/dev/net/tun", O_RDWR);
    if (fd < 0) { perror("/dev/net/tun"); return -1; }
    struct ifreq ifr; memset(&ifr, 0, sizeof ifr);
    ifr.ifr_flags = IFF_TUN | IFF_NO_PI;
    snprintf(ifr.ifr_name, sizeof ifr.ifr_name, "%s", name);
    if (ioctl(fd, TUNSETIFF, &ifr) < 0) { perror("TUNSETIFF"); close(fd); return -1; }
    snprintf(out, IFNAMSIZ, "%s", ifr.ifr_name);
    return fd;
}

static int tun_config(const char *name, uint32_t ip, int prefix, int mtu) {
    struct ifreq ifr; memset(&ifr, 0, sizeof ifr);
    snprintf(ifr.ifr_name, sizeof ifr.ifr_name, "%s", name);
    int s = socket(AF_INET, SOCK_DGRAM, 0), ok = s >= 0;
    struct sockaddr_in *sa = (struct sockaddr_in *)&ifr.ifr_addr;
    sa->sin_family = AF_INET; sa->sin_addr.s_addr = ip;
    ok = ok && ioctl(s, SIOCSIFADDR, &ifr) == 0;
    sa->sin_family = AF_INET; sa->sin_addr.s_addr = htonl(0xFFFFFFFFu << (32 - prefix));
    ok = ok && ioctl(s, SIOCSIFNETMASK, &ifr) == 0;
    ifr.ifr_mtu = mtu;
    ok = ok && ioctl(s, SIOCSIFMTU, &ifr) == 0;
    ok = ok && ioctl(s, SIOCGIFFLAGS, &ifr) == 0;
    ifr.ifr_flags |= IFF_UP | IFF_RUNNING;
    ok = ok && ioctl(s, SIOCSIFFLAGS, &ifr) == 0;
    if (s >= 0) close(s);
    return ok ? 0 : -1;
}

static void route_all(const char *dev, const struct sockaddr_in *srv, int on) {
    char cmd[256], a[INET_ADDRSTRLEN];
    inet_ntop(AF_INET, &srv->sin_addr, a, sizeof a);
    if (on) {
        snprintf(cmd, sizeof cmd, "ip route replace %s/32 $(ip route get %s | head -1 | "
                 "grep -oE '(via [0-9.]+|dev [^ ]+)' | tr '\\n' ' ')", a, a);
        if (system(cmd) != 0) fprintf(stderr, "warning: %s failed\n", cmd);
        snprintf(cmd, sizeof cmd, "ip route add 0.0.0.0/1 dev %s && ip route add 128.0.0.0/1 dev %s", dev, dev);
    } else snprintf(cmd, sizeof cmd, "ip route del %s/32 2>/dev/null", a);
    if (system(cmd) != 0 && on) fprintf(stderr, "warning: %s failed\n", cmd);
}

int main(int argc, char **argv) {
    const char *link = NULL, *tun_name = "kanki%d", *devhex = NULL;
    int all = 0, ping = 0;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--tun") && i + 1 < argc) tun_name = argv[++i];
        else if (!strcmp(argv[i], "--devid") && i + 1 < argc) devhex = argv[++i];
        else if (!strcmp(argv[i], "--route-all")) all = 1;
        else if (!strcmp(argv[i], "--ping")) ping = 1;
        else if (!link && !strncmp(argv[i], "kanki://", 8)) link = argv[i];
        else link = NULL, i = argc;
    }
    vpnc_cfg c; memset(&c, 0, sizeof c);
    char type[16];
    if (!link || parse_link(link, &c, type, sizeof type) != 0) {
        fprintf(stderr, "usage: kanki-vpn 'kanki://KEY@host:port?...' [--tun NAME] [--devid 16hex] [--route-all] [--ping]\n");
        return 1;
    }
    if (strcmp(type, "udp")) { fprintf(stderr, "only type=udp links are supported by this client\n"); return 1; }
    if (devhex && strlen(devhex) == 16) for (int i = 0; i < 8; i++) sscanf(devhex + 2 * i, "%2hhx", &c.devid[i]);
    else RAND_bytes(c.devid, 8);
    setvbuf(stderr, NULL, _IOLBF, 0);

    if (ping) {
        int ms = vpnc_ping(&c, 4, 1500);
        if (ms >= 0) printf("ping %d ms\n", ms);
        else printf(ms == -4 ? "denied\n" : ms == -2 ? "cannot resolve\n" : "no answer\n");
        return ms >= 0 ? 0 : 1;
    }
    struct sigaction sa = { .sa_handler = on_sig };
    sigaction(SIGINT, &sa, NULL); sigaction(SIGTERM, &sa, NULL);

    vpnc v; vpnc_stats st; memset(&st, 0, sizeof st);
    int r = vpnc_open(&v, &c);
    if (r != VPNC_OK) { fprintf(stderr, "cannot open (%d)\n", r); return 1; }
    char dev[IFNAMSIZ];
    int tun = tun_create(tun_name, dev);
    if (tun < 0) return 1;
    uint32_t want = 0;
    int routed = 0;
    while (running) {
        r = vpnc_hello(&v, want, 10000, &running, &st);
        if (r == VPNC_E_DENIED) { fprintf(stderr, "server refused: %s\n", st.deny); break; }
        if (r != VPNC_OK) { fprintf(stderr, "no answer from server, retrying\n"); continue; }
        if (tun_config(dev, v.ip, v.prefix, v.mtu) != 0) { perror("configure tun"); break; }
        fprintf(stderr, "connected: %s %s/%d mtu %d dns %s\n", dev, inet_ntoa(*(struct in_addr *)&v.ip),
                v.prefix, v.mtu, v.dns);
        if (all && !routed) { route_all(dev, &v.srv, 1); routed = 1; }
        want = v.ip;
        r = vpnc_run(&v, tun, &running, &st);
        if (r == VPNC_E_DENIED) { fprintf(stderr, "server refused: %s\n", st.deny); break; }
        if (r == VPNC_E_READDR) { want = v.ip; fprintf(stderr, "server changed our address\n"); continue; }
    }
    if (routed) route_all(dev, &v.srv, 0);
    fprintf(stderr, "rx %llu tx %llu bytes\n", (unsigned long long)st.rx_bytes, (unsigned long long)st.tx_bytes);
    vpnc_close(&v);
    close(tun);
    return r == VPNC_E_DENIED ? 2 : 0;
}

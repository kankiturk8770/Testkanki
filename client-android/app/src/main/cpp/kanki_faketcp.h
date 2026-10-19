/* kanki_faketcp.h — hide kanki UDP payloads inside fake TCP segments.
   UDP-blocking / UDP-throttling networks see a plausible TCP stream.
   Requires root or CAP_NET_RAW on Linux; on Android needs root (or use UDP mode). */
#ifndef KANKI_FAKETCP_H
#define KANKI_FAKETCP_H

#include <stdint.h>
#include <string.h>
#include <stdlib.h>
#include <arpa/inet.h>
#include <netinet/ip.h>
#include <netinet/tcp.h>
#include <sys/socket.h>

typedef struct {
    int      fd;                 /* raw socket, IPPROTO_TCP */
    uint16_t local_port;
    uint32_t seq, ack;           /* fake stream state */
    uint32_t local_ip, remote_ip;
    uint16_t remote_port;
    int      established;
} ftcp_t;

static uint16_t csum16(const void *data, int len) {
    const uint16_t *p = data;
    uint32_t sum = 0;
    while (len > 1) { sum += *p++; len -= 2; }
    if (len) sum += *(const uint8_t *)p;
    while (sum >> 16) sum = (sum & 0xFFFF) + (sum >> 16);
    return (uint16_t)~sum;
}

static uint16_t tcp_csum(uint32_t src, uint32_t dst, const struct tcphdr *th, int tcplen) {
    struct {
        uint32_t src, dst;
        uint8_t  zero, proto;
        uint16_t len;
    } ph;
    ph.src = src; ph.dst = dst; ph.zero = 0;
    ph.proto = IPPROTO_TCP; ph.len = htons((uint16_t)tcplen);
    uint8_t buf[2048];
    memcpy(buf, &ph, sizeof ph);
    memcpy(buf + sizeof ph, th, tcplen);
    return csum16(buf, (int)sizeof(ph) + tcplen);
}

/* open raw TCP socket; local_port must be firewalled (or accept RST noise) */
static int ftcp_open(ftcp_t *f, uint16_t local_port) {
    f->fd = socket(AF_INET, SOCK_RAW, IPPROTO_TCP);
    if (f->fd < 0) return -1;
    int one = 1;
    setsockopt(f->fd, IPPROTO_IP, IP_HDRINCL, &one, sizeof(one));
    struct timeval tv = { .tv_sec = 0, .tv_usec = 100000 };
    setsockopt(f->fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    f->local_port = local_port;
    f->seq = (uint32_t)rand();
    f->ack = 0;
    f->established = 0;
    return 0;
}

/* send payload as one fake TCP PSH+ACK segment (payload = one kanki wire pkt) */
static int ftcp_send(ftcp_t *f, const uint8_t *payload, int plen) {
    uint8_t pkt[2048];
    struct iphdr *ip = (struct iphdr *)pkt;
    struct tcphdr *tcp = (struct tcphdr *)(pkt + sizeof(struct iphdr));
    int tcplen = (int)sizeof(struct tcphdr) + plen;
    int totlen = (int)sizeof(struct iphdr) + tcplen;
    if (totlen > (int)sizeof(pkt)) return -1;

    memset(pkt, 0, sizeof(struct iphdr) + sizeof(struct tcphdr));
    ip->version = 4; ip->ihl = 5;
    ip->tos = 0x10;                                 /* low-delay */
    ip->tot_len = htons((uint16_t)totlen);
    ip->id = htons((uint16_t)(rand() & 0xFFFF));
    ip->frag_off = htons(IP_DF);
    ip->ttl = 64;
    ip->protocol = IPPROTO_TCP;
    ip->saddr = f->local_ip;
    ip->daddr = f->remote_ip;
    ip->check = csum16(ip, sizeof(struct iphdr));

    tcp->source = htons(f->local_port);
    tcp->dest   = htons(f->remote_port);
    tcp->seq    = htonl(f->seq);
    tcp->ack_seq= htonl(f->ack);
    tcp->doff   = 5;
    tcp->psh    = 1; tcp->ack = 1;
    tcp->window = htons(64240);
    memcpy(pkt + sizeof(struct iphdr) + sizeof(struct tcphdr), payload, plen);
    tcp->check = tcp_csum(ip->saddr, ip->daddr, tcp, tcplen);

    struct sockaddr_in dst = { .sin_family = AF_INET,
        .sin_addr.s_addr = f->remote_ip, .sin_port = htons(f->remote_port) };
    int r = (int)sendto(f->fd, pkt, totlen, 0, (struct sockaddr *)&dst, sizeof dst);
    if (r > 0) f->seq += (uint32_t)plen;            /* keep seq plausible */
    return r;
}

/* receive one fake TCP segment carrying a kanki wire packet.
   Returns payload length, 0 on timeout/no-match, -1 error. */
static int __attribute__((unused)) ftcp_recv(ftcp_t *f, uint8_t *out, int outlen, uint32_t *peer_ip) {
    uint8_t buf[2048];
    ssize_t n = recv(f->fd, buf, sizeof buf, 0);
    if (n <= 0) return 0;
    struct iphdr *ip = (struct iphdr *)buf;
    if (ip->protocol != IPPROTO_TCP || ip->version != 4) return 0;
    int ihl = ip->ihl * 4;
    struct tcphdr *tcp = (struct tcphdr *)(buf + ihl);
    if (ntohs(tcp->dest) != f->local_port) return 0;   /* not our stream */
    int doff = tcp->doff * 4;
    int plen = (int)n - ihl - doff;
    if (plen <= 0) {
        /* bare ACK/SYN etc: keep ack state warm */
        f->ack = ntohl(tcp->seq);
        if (tcp->syn && !tcp->ack && !f->established) { /* reply SYN+ACK-ish */
            f->established = 1;
            f->ack = ntohl(tcp->seq) + 1;
        }
        return 0;
    }
    if (plen > outlen) plen = outlen;
    memcpy(out, buf + ihl + doff, plen);
    f->ack = ntohl(tcp->seq) + (uint32_t)(n - ihl - doff);
    f->established = 1;
    if (peer_ip) *peer_ip = ip->saddr;
    return plen;
}

#endif /* KANKI_FAKETCP_H */

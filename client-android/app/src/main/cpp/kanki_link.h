/* kanki_link.h — send/receive machinery: multiplication + FEC + dedup */
#ifndef KANKI_LINK_H
#define KANKI_LINK_H
#include "kanki.h"
#include "kanki_faketcp.h"
#include <sys/socket.h>
#include <netinet/in.h>

typedef struct {
    kanki_cfg cfg;
    fec_t     fec;
    dedup_t   dedup;
    uint32_t  tx_block;
    uint8_t   tx_idx;
    uint16_t  par_len;
    uint8_t   parity[KANKI_MAX_MTU];
    uint64_t  blk_seq[MAX_FEC_K];
    uint8_t   blk_flags[MAX_FEC_K];
    uint16_t  blk_len[MAX_FEC_K];
    /* --- auto-tune state --- */
    int       autotune;           /* 1 = adapt repeat to measured loss */
    uint32_t  at_arrivals;        /* all copies seen in window */
    uint32_t  at_unique;          /* unique seqs in window */
    int       at_window;          /* window size in unique pkts */
    int       pending_tune;       /* new repeat value to announce, 0 = none */
    ftcp_t   *ft;                 /* non-NULL => fake-TCP transport */
} kanki_link;

static void link_init(kanki_link *l, const uint8_t psk[32], int repeat, int fec_k, int fec_on) {
    kanki_init(&l->cfg, psk, repeat, fec_k, fec_on);
    fec_init(&l->fec);
    dedup_init(&l->dedup);
    l->tx_block = 1; l->tx_idx = 0; l->par_len = 0;
    l->autotune = 0; l->at_arrivals = 0; l->at_unique = 0;
    l->at_window = 64; l->pending_tune = 0; l->ft = NULL;
}

/* pick repeat from measured loss% */
static int tune_pick(double loss) {
    if (loss < 0.05) return 3;
    if (loss < 0.15) return 4;
    if (loss < 0.25) return 6;
    if (loss < 0.40) return 8;
    return 10;
}

/* note one arriving copy (unique or dup); sets pending_tune when window closes */
static void tune_note(kanki_link *l, int is_dup, int sender_repeat) {
    if (!l->autotune || sender_repeat <= 0) return;
    l->at_arrivals++;
    if (!is_dup) l->at_unique++;
    if (l->at_unique >= (uint32_t)l->at_window) {
        double expected = (double)l->at_window * sender_repeat;
        double loss = 1.0 - (double)l->at_arrivals / expected;
        if (loss < 0) loss = 0;
        int want = tune_pick(loss);
        if (want != sender_repeat) l->pending_tune = want;   /* tell the peer */
        l->at_arrivals = 0; l->at_unique = 0;
    }
}

/* apply a TUNE control packet: payload "TUNE:<n>" */
static int tune_apply(kanki_link *l, const kanki_pkt *pkt) {
    if (!(pkt->flags & FLAG_CONTROL) || pkt->payload_len < 6) return 0;
    if (memcmp(pkt->payload, "TUNE:", 5) != 0) return 0;
    int n = atoi((const char *)pkt->payload + 5);
    if (n < MIN_REPEAT) n = MIN_REPEAT;
    if (n > MAX_REPEAT) n = MAX_REPEAT;
    l->cfg.repeat = n;
    return 1;
}

/* multiply-and-send one wire packet */
static void link_tx_copies(kanki_link *l, int fd, const struct sockaddr *to, socklen_t tolen,
                           uint8_t flags, uint64_t seq, uint32_t fb, uint8_t fidx,
                           const uint8_t *payload, uint16_t plen) {
    int n = (flags & (FLAG_CONTROL | FLAG_TAIL)) ? MAX_REPEAT : l->cfg.repeat;
    for (int i = 0; i < n; i++) {
        uint8_t wire[KANKI_MAX_PKT];
        int wlen = kanki_seal2(&l->cfg, flags, seq, fb, fidx, l->cfg.fec_k,
                               payload, plen, wire);
        if (l->ft) ftcp_send(l->ft, wire, wlen);
        else       sendto(fd, wire, wlen, 0, to, tolen);
        if (i + 1 < n) kanki_jitter_us(l->cfg.jitter_us);
    }
}

/* flush pending FEC block (parity for partial block — protects the TAIL too) */
static void link_fec_flush(kanki_link *l, int fd, const struct sockaddr *to, socklen_t tolen) {
    if (!l->cfg.fec_enabled || l->tx_idx == 0) return;
    link_tx_copies(l, fd, to, tolen, FLAG_PARITY, l->cfg.tx_seq++,
                   l->tx_block, FEC_PARITY_IDX, l->parity, l->par_len);
    l->tx_block++;
    l->tx_idx = 0;
    l->par_len = 0;
    memset(l->parity, 0, sizeof(l->parity));
}

/* send one app payload through multiplication + FEC */
static void link_send(kanki_link *l, int fd, const struct sockaddr *to, socklen_t tolen,
                      uint8_t flags, const uint8_t *payload, uint16_t plen) {
    if (plen > KANKI_MAX_MTU) plen = KANKI_MAX_MTU;
    uint64_t seq = l->cfg.tx_seq++;
    if (l->cfg.fec_enabled) {
        if (l->tx_idx >= l->cfg.fec_k) link_fec_flush(l, fd, to, tolen);
        int i = l->tx_idx;
        l->blk_seq[i] = seq; l->blk_flags[i] = flags; l->blk_len[i] = plen;
        if (plen > l->par_len) {
            /* zero-extend parity before xoring longer shard */
            for (int j = l->par_len; j < plen; j++) l->parity[j] = 0;
            l->par_len = plen;
        }
        fec_xor(l->parity, payload, plen);
        l->tx_idx++;
        link_tx_copies(l, fd, to, tolen, flags, seq, l->tx_block, (uint8_t)i, payload, plen);
        if (l->tx_idx >= l->cfg.fec_k) link_fec_flush(l, fd, to, tolen);
    } else {
        link_tx_copies(l, fd, to, tolen, flags, seq, 0, 0, payload, plen);
    }
    if (flags & FLAG_TAIL) link_fec_flush(l, fd, to, tolen);
}

/* receive one wire packet; returns payload via out. 1 = deliver, 0 = dup/recovered-nothing */
static int link_recv(kanki_link *l, const uint8_t *wire, int wlen, kanki_pkt *out) {
    kanki_pkt pkt;
    if (kanki_open2(&l->cfg, wire, wlen, &pkt) != 0) return 0;
    if (tune_apply(l, &pkt)) return 0;                 /* TUNE control */
    if (pkt.fec_idx != FEC_PARITY_IDX && l->cfg.fec_enabled && pkt.fec_k >= 2) {
        int dup = dedup_seen(&l->dedup, pkt.seq);
        tune_note(l, dup, l->cfg.repeat);              /* sender uses same repeat */
        if (dup) return 0;
        kanki_pkt rec;
        if (fec_feed(&l->fec, &pkt, &rec)) {
            /* deliver current packet now; recovered one is reported via out on
               a subsequent call pattern — v0.1: deliver current, stash rec */
            *out = pkt;
            return 1;
        }
        *out = pkt;
        return 1;
    }
    if (pkt.fec_idx == FEC_PARITY_IDX) {
        kanki_pkt rec;
        if (fec_feed(&l->fec, &pkt, &rec) && rec.payload_len > 0) {
            if (!dedup_seen(&l->dedup, rec.seq)) { *out = rec; return 2; } /* 2 = FEC-recovered */
        }
        return 0;
    }
    if (dedup_seen(&l->dedup, pkt.seq)) { tune_note(l, 1, l->cfg.repeat); return 0; }
    tune_note(l, 0, l->cfg.repeat);
    *out = pkt;
    return 1;
}

/* announce a new repeat to the peer (CONTROL, always 10x) */
static void link_send_tune(kanki_link *l, int fd, const struct sockaddr *to, socklen_t tolen) {
    if (!l->pending_tune) return;
    char m[16];
    int n = snprintf(m, sizeof m, "TUNE:%d", l->pending_tune);
    link_tx_copies(l, fd, to, tolen, FLAG_CONTROL, l->cfg.tx_seq++, 0, 0,
                   (const uint8_t *)m, (uint16_t)n);
    l->pending_tune = 0;
}

#endif

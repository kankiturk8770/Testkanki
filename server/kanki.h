#ifndef KANKI_H
#define KANKI_H

#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <time.h>
#include <sys/time.h>
#include <unistd.h>
#include <openssl/evp.h>
#include <openssl/kdf.h>
#include <openssl/rand.h>

#define KANKI_VERSION   0x01
#define KANKI_MAX_MTU   1400
#define KANKI_HDR_LEN   (12+1+1+8+4+1+1+2)   /* nonce..payload_len */
#define KANKI_TAG_LEN   16
#define KANKI_MAX_PAD   48
#define KANKI_MAX_PKT   (KANKI_MAX_MTU + 256)
#define KANKI_FEC_HDR   3                    /* flags + len, XORed into parity */
#define KANKI_MAX_PAYLOAD (KANKI_MAX_MTU + KANKI_FEC_HDR)

#define FLAG_DATA    0x01
#define FLAG_PARITY  0x02
#define FLAG_CONTROL 0x04
#define FLAG_TAIL    0x08

#define FEC_PARITY_IDX 0xFF
#define DEFAULT_REPEAT  4
#define MAX_REPEAT     10
#define MIN_REPEAT      3
#define DEFAULT_FEC_K   8
#define MAX_FEC_K      16

typedef struct {
    uint8_t  psk[32];
    uint8_t  enc_key[32];
    uint8_t  keyid;
    int      repeat;        /* 3..10 */
    int      fec_k;         /* data shards per block */
    int      fec_enabled;
    uint64_t tx_seq;
    uint64_t epoch;
    int      jitter_us;      /* inter-copy jitter in microseconds */
    uint64_t rx_epoch;       /* epoch the rx key cache below was built for */
    uint8_t  rx_key[3][32];  /* epoch-1, epoch, epoch+1 (clock skew) */
    uint8_t  rx_keyid[3];
} kanki_cfg;

/* Validate full IPv4 datagrams before injecting them into a TUN device. */
static inline int kanki_ipv4_valid(const uint8_t *p, size_t n, size_t mtu) {
    if (n < 20 || n > mtu || (p[0] >> 4) != 4) return 0;
    size_t ihl = (p[0] & 15) * 4u;
    return ihl >= 20 && ihl <= n && (((size_t)p[2] << 8) | p[3]) == n;
}

static inline int kanki_parse_key(const char *hex, uint8_t key[32]) {
    if (!hex || strlen(hex) != 64) return -1;
    for (int i = 0; i < 64; i++) {
        unsigned char c = hex[i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') ||
              (c >= 'A' && c <= 'F'))) return -1;
    }
    for (int i = 0; i < 32; i++)
        if (sscanf(hex + i * 2, "%2hhx", &key[i]) != 1) return -1;
    return 0;
}

/* ---------- crypto ---------- */

static void kanki_jitter_us(int max_us) {
    if (max_us <= 0) return;
    struct timespec ts;
    long us = (long)(rand() % max_us);
    ts.tv_sec = us / 1000000;
    ts.tv_nsec = (us % 1000000) * 1000L;
    nanosleep(&ts, NULL);
}

/* derive epoch key material from PSK */
static void kanki_derive_epoch(kanki_cfg *c, uint64_t epoch) {
    uint8_t salt[8];
    for (int i = 0; i < 8; i++) salt[i] = (uint8_t)(epoch >> (8 * i));
    uint8_t okm[33];
    EVP_PKEY_CTX *pctx = EVP_PKEY_CTX_new_id(EVP_PKEY_HKDF, NULL);
    size_t okmlen = sizeof(okm);
    EVP_PKEY_derive_init(pctx);
    EVP_PKEY_CTX_set_hkdf_md(pctx, EVP_sha256());
    EVP_PKEY_CTX_set1_hkdf_salt(pctx, salt, 8);
    EVP_PKEY_CTX_set1_hkdf_key(pctx, c->psk, 32);
    EVP_PKEY_CTX_add1_hkdf_info(pctx, (uint8_t *)"kanki-v1", 8);
    EVP_PKEY_derive(pctx, okm, &okmlen);
    EVP_PKEY_CTX_free(pctx);
    memcpy(c->enc_key, okm, 32);
    c->keyid = okm[32];
    c->epoch = epoch;
}

static uint64_t kanki_now_epoch(void) {
    return (uint64_t)time(NULL) / 600;   /* 10-minute epochs */
}

static void kanki_init(kanki_cfg *c, const uint8_t psk[32], int repeat, int fec_k, int fec_on) {
    memcpy(c->psk, psk, 32);
    c->repeat = repeat < MIN_REPEAT ? MIN_REPEAT : (repeat > MAX_REPEAT ? MAX_REPEAT : repeat);
    c->fec_k  = fec_k < 2 ? 2 : (fec_k > MAX_FEC_K ? MAX_FEC_K : fec_k);
    c->fec_enabled = fec_on;
    /* seq space starts at wall-clock µs*16 so a restarted peer is never
       mistaken for a replay of the previous session by the dedup window */
    struct timeval tv; gettimeofday(&tv, NULL);
    c->tx_seq = (((uint64_t)tv.tv_sec * 1000000u + (uint64_t)tv.tv_usec) << 4) | 1;
    c->jitter_us = 1500;
    c->rx_epoch = 0;
    kanki_derive_epoch(c, kanki_now_epoch());
    RAND_poll();
}

typedef struct {
    uint8_t  flags;
    uint64_t seq;
    uint32_t fec_block;
    uint8_t  fec_idx;
    uint8_t  fec_k;
    uint16_t payload_len;
    uint8_t  payload[KANKI_MAX_PAYLOAD];
} kanki_pkt;

static int kanki_seal2(kanki_cfg *c, uint8_t flags, uint64_t seq,
                       uint32_t fec_block, uint8_t fec_idx, uint8_t fec_k,
                       const uint8_t *payload, uint16_t plen, uint8_t *out) {
    if (plen > KANKI_MAX_PAYLOAD || (plen && !payload)) return -1;
    if (kanki_now_epoch() != c->epoch) kanki_derive_epoch(c, kanki_now_epoch());
    /* fresh random 96-bit GCM IV per copy, sent in clear */
    uint8_t iv[12];
    if (RAND_bytes(iv, sizeof iv) != 1) return -1;

    uint8_t plain[KANKI_MAX_PKT], *p = plain;
    uint8_t padlen = 0; RAND_bytes(&padlen, 1); padlen %= (KANKI_MAX_PAD + 1);
    *p++ = KANKI_VERSION;
    *p++ = flags;
    for (int i = 7; i >= 0; i--) *p++ = (uint8_t)(seq >> (8 * i));
    *p++ = (uint8_t)(fec_block >> 24); *p++ = (uint8_t)(fec_block >> 16);
    *p++ = (uint8_t)(fec_block >> 8);  *p++ = (uint8_t)fec_block;
    *p++ = fec_idx; *p++ = fec_k;
    *p++ = (uint8_t)(plen >> 8); *p++ = (uint8_t)plen;
    if (plen) memcpy(p, payload, plen);
    p += plen;
    if (RAND_bytes(p, padlen) != 1) return -1;
    p += padlen;
    int plain_len = (int)(p - plain);

    EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new();
    int len, total = 0;
    out[0] = c->keyid;
    memcpy(out + 1, iv, 12);   /* 12-byte IV in clear — random-looking, harmless */
    if (!ctx) return -1;
    EVP_EncryptInit_ex(ctx, EVP_aes_256_gcm(), NULL, NULL, NULL);
    EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, 12, NULL);
    EVP_EncryptInit_ex(ctx, NULL, NULL, c->enc_key, iv);
    EVP_EncryptUpdate(ctx, NULL, &len, out, 13);   /* AAD = keyid+iv */
    EVP_EncryptUpdate(ctx, out + 13, &len, plain, plain_len);
    total = len;
    EVP_EncryptFinal_ex(ctx, out + 13 + total, &len);
    total += len;
    EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_GET_TAG, KANKI_TAG_LEN, out + 13 + total);
    EVP_CIPHER_CTX_free(ctx);
    return total + KANKI_TAG_LEN + 13;
}

/* (re)build the rx key cache for the current epoch and its neighbours */
static void kanki_rx_refresh(kanki_cfg *c) {
    uint64_t now = kanki_now_epoch();
    if (c->rx_epoch == now) return;
    for (int i = 0; i < 3; i++) {
        kanki_cfg tmp = *c;
        kanki_derive_epoch(&tmp, now - 1 + (uint64_t)i);
        memcpy(c->rx_key[i], tmp.enc_key, 32);
        c->rx_keyid[i] = tmp.keyid;
    }
    c->rx_epoch = now;
}

static int kanki_open2(kanki_cfg *c, const uint8_t *in, int inlen, kanki_pkt *pkt) {
    if (inlen < 13 + 18 + KANKI_TAG_LEN || inlen - 13 - KANKI_TAG_LEN > KANKI_MAX_PKT) return -1;
    kanki_rx_refresh(c);
    static const int order[3] = { 1, 0, 2 };          /* current epoch first */
    for (int e = 0; e < 3; e++) {
        const uint8_t *key = c->rx_key[order[e]];
        if (in[0] != c->rx_keyid[order[e]]) continue;
        EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new();
        if (!ctx) return -1;
        uint8_t plain[KANKI_MAX_PKT];
        int len, total = 0;
        EVP_DecryptInit_ex(ctx, EVP_aes_256_gcm(), NULL, NULL, NULL);
        EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, 12, NULL);
        EVP_DecryptInit_ex(ctx, NULL, NULL, key, in + 1);
        EVP_DecryptUpdate(ctx, NULL, &len, in, 13);
        if (!EVP_DecryptUpdate(ctx, plain, &len, in + 13, inlen - 13 - KANKI_TAG_LEN))
            { EVP_CIPHER_CTX_free(ctx); continue; }
        total = len;
        EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_TAG, KANKI_TAG_LEN, (void *)(in + inlen - KANKI_TAG_LEN));
        if (EVP_DecryptFinal_ex(ctx, plain + total, &len) <= 0)
            { EVP_CIPHER_CTX_free(ctx); continue; }
        total += len;
        EVP_CIPHER_CTX_free(ctx);
        if (total < 18) return -1;
        uint8_t *p = plain;
        if (*p++ != KANKI_VERSION) return -1;
        pkt->flags = *p++;
        pkt->seq = 0;
        for (int i = 0; i < 8; i++) pkt->seq = (pkt->seq << 8) | *p++;
        pkt->fec_block = ((uint32_t)p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3];
        p += 4;
        pkt->fec_idx = *p++;
        pkt->fec_k = *p++;
        pkt->payload_len = ((uint16_t)p[0] << 8) | p[1];
        p += 2;
        if (pkt->payload_len > KANKI_MAX_PAYLOAD || p + pkt->payload_len > plain + total) return -1;
        memcpy(pkt->payload, p, pkt->payload_len);
        return 0;
    }
    return -1;
}

/* ---------- dedup window ---------- */
#define DEDUP_BITS (1 << 16)
typedef struct { uint64_t top; uint8_t bits[DEDUP_BITS / 8]; } dedup_t;

static void dedup_init(dedup_t *d) { d->top = 0; memset(d->bits, 0, sizeof(d->bits)); }

/* sliding window over the last DEDUP_BITS seqs below the highest one seen.
   returns 1 if this seq was already seen (drop), 0 if new */
static int dedup_seen(dedup_t *d, uint64_t seq) {
    if (seq > d->top) {
        uint64_t gap = seq - d->top;
        if (d->top == 0 || gap >= DEDUP_BITS) memset(d->bits, 0, sizeof(d->bits));
        else for (uint64_t s = d->top + 1; s <= seq; s++)
            d->bits[(s % DEDUP_BITS) >> 3] &= (uint8_t)~(1 << (s & 7));
        d->top = seq;
    } else if (d->top - seq >= DEDUP_BITS) {
        return 1;                                  /* too old */
    }
    uint64_t off = seq % DEDUP_BITS;
    uint8_t mask = (uint8_t)(1 << (off & 7));
    uint8_t *b = &d->bits[off >> 3];
    if (*b & mask) return 1;
    *b |= mask;
    return 0;
}

/* ---------- XOR FEC ----------
   Parity = XOR of every shard as [flags(1) | len(2) | payload], zero-padded
   to the longest; the parity packet's seq field carries the XOR of the shard
   seqs and its fec_k field the real shard count of the block (a partial block
   flushed on idle/TAIL has fewer than k shards). So one lost shard is rebuilt
   exactly: flags, seq, length and payload. */
typedef struct {
    uint32_t block;
    uint8_t  have[MAX_FEC_K + 1];     /* last slot = parity */
    uint16_t len[MAX_FEC_K + 1];
    uint8_t  data[MAX_FEC_K + 1][KANKI_MAX_PAYLOAD];
    uint8_t  k;                       /* shard count, known once parity arrives */
    uint64_t seq[MAX_FEC_K + 1];
    uint8_t  flags[MAX_FEC_K + 1];
} fec_block_t;

#define FEC_CACHE 32
typedef struct { fec_block_t blk[FEC_CACHE]; uint32_t next_evict; } fec_t;

static void fec_init(fec_t *f) {
    memset(f, 0, sizeof(*f));
    for (int i = 0; i < FEC_CACHE; i++) f->blk[i].block = 0xFFFFFFFF;
}

static void fec_xor(uint8_t *dst, const uint8_t *src, int n) {
    for (int i = 0; i < n; i++) dst[i] ^= src[i];
}

/* XOR one shard, framed as [flags|len|payload], into dst */
static void fec_xor_shard(uint8_t *dst, uint8_t flags, const uint8_t *payload, uint16_t plen) {
    dst[0] ^= flags;
    dst[1] ^= (uint8_t)(plen >> 8);
    dst[2] ^= (uint8_t)plen;
    if (plen) fec_xor(dst + KANKI_FEC_HDR, payload, plen);
}

/* feed one shard of a block; if exactly one data shard missing and all others
   + parity present, reconstruct it. returns 1 + fills *out if recovered. */
static int fec_feed(fec_t *f, const kanki_pkt *pkt, kanki_pkt *out) {
    int is_par = pkt->fec_idx == FEC_PARITY_IDX;
    if (!is_par && pkt->fec_idx >= MAX_FEC_K) return 0;
    if (is_par && (pkt->fec_k < 1 || pkt->fec_k > MAX_FEC_K)) return 0;
    fec_block_t *b = NULL;
    for (int i = 0; i < FEC_CACHE; i++)
        if (f->blk[i].block == pkt->fec_block) { b = &f->blk[i]; break; }
    if (!b) {
        for (int i = 0; i < FEC_CACHE; i++)
            if (f->blk[i].block == 0xFFFFFFFF) { b = &f->blk[i]; break; }
        if (!b) b = &f->blk[f->next_evict++ % FEC_CACHE];   /* evict round-robin */
        memset(b, 0, sizeof(*b));
        b->block = pkt->fec_block;
    }
    int slot = is_par ? MAX_FEC_K : pkt->fec_idx;
    if (b->have[slot]) return 0;
    b->have[slot] = 1;
    b->len[slot] = pkt->payload_len;
    memcpy(b->data[slot], pkt->payload, pkt->payload_len);
    b->seq[slot] = pkt->seq;
    b->flags[slot] = pkt->flags;
    if (is_par) b->k = pkt->fec_k;

    /* can we recover exactly one missing data shard? */
    if (!b->have[MAX_FEC_K]) return 0;
    int k = b->k, missing = -1, miss_cnt = 0;
    for (int i = 0; i < k; i++) if (!b->have[i]) { missing = i; miss_cnt++; }
    if (miss_cnt != 1) return 0;

    uint16_t plen = b->len[MAX_FEC_K];
    if (plen < KANKI_FEC_HDR) return 0;
    uint8_t rec[KANKI_MAX_PAYLOAD];
    memcpy(rec, b->data[MAX_FEC_K], plen);
    uint64_t seq = b->seq[MAX_FEC_K];
    for (int i = 0; i < k; i++) {
        if (i == missing) continue;
        if (b->len[i] + KANKI_FEC_HDR > plen) return 0;      /* malformed */
        fec_xor_shard(rec, b->flags[i], b->data[i], b->len[i]);
        seq ^= b->seq[i];
    }
    uint16_t rlen = (uint16_t)((rec[1] << 8) | rec[2]);
    if (rlen > KANKI_MAX_MTU || rlen + KANKI_FEC_HDR > plen) return 0;
    b->have[missing] = 1;                       /* never rebuild it twice */
    memset(out, 0, sizeof(*out));
    out->flags = rec[0];
    out->seq = seq;
    out->fec_block = pkt->fec_block;
    out->fec_idx = (uint8_t)missing;
    out->fec_k = (uint8_t)k;
    out->payload_len = rlen;
    memcpy(out->payload, rec + KANKI_FEC_HDR, rlen);
    return 1;
}

#endif /* KANKI_H */

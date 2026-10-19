#ifndef KANKI_H
#define KANKI_H

#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <time.h>
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
} kanki_cfg;

/* ---------- crypto ---------- */

static void kanki_jitter_us(int max_us) {
    if (max_us <= 0) return;
    struct timespec ts;
    ts.tv_sec = 0;
    ts.tv_nsec = (long)(rand() % max_us) * 1000L;
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
    c->tx_seq = 1;
    c->jitter_us = 1500;
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
    uint8_t  payload[KANKI_MAX_MTU];
} kanki_pkt;

/* GCM IV derivation: random IV sent in clear (harmless), AAD = keyid+iv. */
static void kanki_iv(const uint8_t key[32], uint64_t seq, uint8_t iv[12]) {
    uint8_t info[10];
    info[0] = 'i'; info[1] = 'v';
    for (int i = 0; i < 8; i++) info[2 + i] = (uint8_t)(seq >> (8 * (7 - i)));
    EVP_PKEY_CTX *pctx = EVP_PKEY_CTX_new_id(EVP_PKEY_HKDF, NULL);
    size_t l = 12;
    EVP_PKEY_derive_init(pctx);
    EVP_PKEY_CTX_set_hkdf_md(pctx, EVP_sha256());
    EVP_PKEY_CTX_set1_hkdf_salt(pctx, (uint8_t *)"", 0);
    EVP_PKEY_CTX_set1_hkdf_key(pctx, (uint8_t *)key, 32);
    EVP_PKEY_CTX_add1_hkdf_info(pctx, info, 10);
    EVP_PKEY_derive(pctx, iv, &l);
    EVP_PKEY_CTX_free(pctx);
}

static int kanki_seal2(kanki_cfg *c, uint8_t flags, uint64_t seq,
                       uint32_t fec_block, uint8_t fec_idx, uint8_t fec_k,
                       const uint8_t *payload, uint16_t plen, uint8_t *out) {
    if (kanki_now_epoch() != c->epoch) kanki_derive_epoch(c, kanki_now_epoch());
    uint8_t iv[12];
    kanki_iv(c->enc_key, seq ^ ((uint64_t)fec_idx << 56) ^ ((uint64_t)rand() << 1), iv);
    /* NOTE: IV must be reproducible ONLY by sender; receiver uses tag check,
       so uniqueness per copy is what matters (rand salt above). */

    uint8_t plain[KANKI_MAX_PKT], *p = plain;
    uint8_t padlen = 0; RAND_bytes(&padlen, 1); padlen %= (KANKI_MAX_PAD + 1);
    *p++ = KANKI_VERSION;
    *p++ = flags;
    for (int i = 7; i >= 0; i--) *p++ = (uint8_t)(seq >> (8 * i));
    *p++ = (uint8_t)(fec_block >> 24); *p++ = (uint8_t)(fec_block >> 16);
    *p++ = (uint8_t)(fec_block >> 8);  *p++ = (uint8_t)fec_block;
    *p++ = fec_idx; *p++ = fec_k;
    *p++ = (uint8_t)(plen >> 8); *p++ = (uint8_t)plen;
    memcpy(p, payload, plen); p += plen;
    p += padlen;
    int plain_len = (int)(p - plain);

    EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new();
    int len, total = 0;
    out[0] = c->keyid;
    out[1] = iv[0]; /* store 12-byte IV in clear — random-looking, harmless */
    memcpy(out + 1, iv, 12);
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

static int kanki_open2(kanki_cfg *c, const uint8_t *in, int inlen, kanki_pkt *pkt) {
    if (inlen < 13 + 14 + KANKI_TAG_LEN) return -1;
    for (int e = 0; e < 2; e++) {
        kanki_cfg tmp = *c;
        if (e == 1) kanki_derive_epoch(&tmp, c->epoch - 1);
        if (in[0] != tmp.keyid) continue;
        EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new();
        uint8_t plain[KANKI_MAX_PKT];
        int len, total = 0;
        EVP_DecryptInit_ex(ctx, EVP_aes_256_gcm(), NULL, NULL, NULL);
        EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, 12, NULL);
        EVP_DecryptInit_ex(ctx, NULL, NULL, tmp.enc_key, in + 1);
        EVP_DecryptUpdate(ctx, NULL, &len, in, 13);
        if (EVP_DecryptUpdate(ctx, plain, &len, in + 13, inlen - 13 - KANKI_TAG_LEN) < 0)
            { EVP_CIPHER_CTX_free(ctx); continue; }
        total = len;
        EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_TAG, KANKI_TAG_LEN, (void *)(in + inlen - KANKI_TAG_LEN));
        if (EVP_DecryptFinal_ex(ctx, plain + total, &len) <= 0)
            { EVP_CIPHER_CTX_free(ctx); continue; }
        total += len;
        EVP_CIPHER_CTX_free(ctx);
        if (total < 14) return -1;
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
        if (pkt->payload_len > KANKI_MAX_MTU || p + pkt->payload_len > plain + total) return -1;
        memcpy(pkt->payload, p, pkt->payload_len);
        return 0;
    }
    return -1;
}

/* ---------- dedup window ---------- */
#define DEDUP_BITS (1 << 16)
typedef struct { uint64_t base; uint8_t bits[DEDUP_BITS / 8]; } dedup_t;

static void dedup_init(dedup_t *d) { d->base = 0; memset(d->bits, 0, sizeof(d->bits)); }

/* returns 1 if this seq was already seen (drop), 0 if new */
static int dedup_seen(dedup_t *d, uint64_t seq) {
    if (d->base == 0) { d->base = seq; }
    if (seq < d->base) return 1;
    uint64_t off = seq - d->base;
    if (off >= DEDUP_BITS) {                       /* slide window */
        memset(d->bits, 0, sizeof(d->bits));
        d->base = seq;
        off = 0;
    }
    uint8_t mask = (uint8_t)(1 << (off & 7));
    uint8_t *b = &d->bits[off >> 3];
    if (*b & mask) return 1;
    *b |= mask;
    return 0;
}

/* ---------- XOR FEC ---------- */
typedef struct {
    uint32_t block;
    uint8_t  have[MAX_FEC_K + 1];     /* last slot = parity */
    uint16_t len[MAX_FEC_K + 1];
    uint8_t  data[MAX_FEC_K + 1][KANKI_MAX_MTU];
    uint8_t  k;
    uint64_t seq[MAX_FEC_K + 1];
    uint8_t  flags[MAX_FEC_K + 1];
} fec_block_t;

#define FEC_CACHE 32
typedef struct { fec_block_t blk[FEC_CACHE]; uint64_t tx_block; uint8_t tx_idx;
                 uint16_t par_len; uint8_t parity[KANKI_MAX_MTU];
                 uint64_t par_seq[MAX_FEC_K]; uint8_t par_flags[MAX_FEC_K];
                 uint16_t par_shard_len[MAX_FEC_K]; } fec_t;

static void fec_init(fec_t *f) {
    memset(f, 0, sizeof(*f));
    for (int i = 0; i < FEC_CACHE; i++) f->blk[i].block = 0xFFFFFFFF;
    f->tx_block = 1; f->tx_idx = 0;
}

static void fec_xor(uint8_t *dst, const uint8_t *src, int n) {
    for (int i = 0; i < n; i++) dst[i] ^= src[i];
}

/* feed one shard of a block; if exactly one data shard missing and all others
   + parity present, reconstruct it. returns 1 + fills *out if recovered. */
static int fec_feed(fec_t *f, const kanki_pkt *pkt, kanki_pkt *out) {
    int k = pkt->fec_k;
    if (k < 2 || k > MAX_FEC_K) return 0;
    fec_block_t *b = NULL;
    for (int i = 0; i < FEC_CACHE; i++)
        if (f->blk[i].block == pkt->fec_block) { b = &f->blk[i]; break; }
    if (!b) {
        for (int i = 0; i < FEC_CACHE; i++)
            if (f->blk[i].block == 0xFFFFFFFF) { b = &f->blk[i]; break; }
        if (!b) { b = &f->blk[0]; }                 /* evict oldest slot 0 */
        memset(b, 0, sizeof(*b));
        b->block = pkt->fec_block; b->k = (uint8_t)k;
    }
    int slot = (pkt->fec_idx == FEC_PARITY_IDX) ? k : pkt->fec_idx;
    if (slot < 0 || slot > k || b->have[slot]) return 0;
    b->have[slot] = 1;
    b->len[slot] = pkt->payload_len;
    memcpy(b->data[slot], pkt->payload, pkt->payload_len);
    b->seq[slot] = pkt->seq;
    b->flags[slot] = pkt->flags;

    /* can we recover exactly one missing data shard? */
    int missing = -1, miss_cnt = 0;
    for (int i = 0; i < k; i++) if (!b->have[i]) { missing = i; miss_cnt++; }
    if (miss_cnt != 1 || !b->have[k]) return 0;

    uint16_t maxlen = 0;
    for (int i = 0; i <= k; i++) if (i != missing && b->len[i] > maxlen) maxlen = b->len[i];
    uint8_t rec[KANKI_MAX_MTU];
    memcpy(rec, b->data[k], b->len[k]);
    memset(rec + b->len[k], 0, maxlen > b->len[k] ? maxlen - b->len[k] : 0);
    for (int i = 0; i < k; i++)
        if (i != missing) fec_xor(rec, b->data[i], b->len[i]);
    /* length recovery: we can't XOR lengths, so receiver pads to maxlen and
       the upper layer trims; keep it simple: recovered len = maxlen. */
    memset(out, 0, sizeof(*out));
    out->flags = b->flags[missing] ? b->flags[missing] : FLAG_DATA;
    out->seq = b->seq[missing] ? b->seq[missing] : 0;
    out->fec_block = pkt->fec_block;
    out->fec_idx = (uint8_t)missing;
    out->fec_k = (uint8_t)k;
    out->payload_len = maxlen;
    memcpy(out->payload, rec, maxlen);
    return 1;
}

#endif /* KANKI_H */

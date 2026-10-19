# KANKI Protocol — Specification v0.1

A private, anti-DPI, loss-immune UDP tunnel for gaming over unstable links.
Not based on any known protocol. Single C codebase: Linux server + Android client (NDK/JNI).

## 1. Design goals

- **Zero perceived loss**: every packet survives via (a) configurable multiplication
  (3–10 copies, user choice) and (b) XOR-FEC recovery without retransmission.
- **No "last packet" loss**: session-control and tail packets are always sent at
  max multiplication (10x).
- **Best ping**: recovery is forward-only (FEC + duplicates). No ACKs, no
  retransmission timers on the data path — latency never waits for loss.
- **Deep anti-DPI**: no magic bytes, no fixed offsets, per-copy re-encryption
  (every duplicate has different ciphertext), random padding, timing jitter,
  header-field masking.

## 2. Wire format

Everything after the first byte is AEAD-encrypted (AES-256-GCM). There is no
plaintext header except a 1-byte key-id used to find the session key.

```
+----------+-------------------------------+--------+
| keyid(1) |  AES-256-GCM ciphertext ...   |tag(16) |
+----------+-------------------------------+--------+
```

Plaintext (before encryption), variable length:

```
nonce(12) | ver(1) | flags(1) | seq(8) | fec_block(4) | fec_idx(1) |
fec_k(1)  | payload_len(2) | payload | random_padding(0..48)
```

- `keyid`   : 1-byte key selector, rotated every epoch, derived via HKDF.
- `nonce`   : random per packet (inside AEAD, so no plaintext repetition ever).
- `seq`     : global 64-bit sequence, for dedup of multiplied copies.
- `fec_*`   : FEC block id, index inside block (0xFF = parity shard), block size.
- `flags`   : bit0 = DATA, bit1 = FEC_PARITY, bit2 = CONTROL, bit3 = TAIL
              (TAIL => send at max multiplication regardless of config).
- Padding length is random per copy; AAD = keyid.

## 3. Packet multiplication (3–10x)

- Config `--repeat N`, N ∈ [3,10], default 4.
- Sender emits N copies of the same plaintext header+payload, each re-encrypted
  with a fresh nonce and fresh padding → N statistically unrelated ciphertexts.
- Inter-copy jitter: 0–1500 µs random sleep (spread burst, confuse timing DPI).
- Receiver: 2^16 sliding-window bitmap on `seq`; first arrival wins, rest dropped.
- CONTROL/TAIL packets: always 10x.

## 4. FEC (XOR parity, on top of multiplication)

- Blocks of K data shards (config `--fec-k`, default 8) + 1 parity shard.
- Parity = bytewise XOR of shards zero-padded to the largest shard in block.
- Receiver buffers a block; if exactly one shard is missing when parity + K-1
  shards are present, the missing shard is reconstructed instantly.
- Flush: partial block is flushed (with parity) when data path idles >2 ms or
  on TAIL — so the **last packet of a burst is always FEC-protected too**.

## 5. Crypto & key schedule

- Pre-shared 32-byte key (PSK).
- HKDF-SHA256(PSK, salt=epoch) → enc_key, keyid, header mask.
- Epoch rotation every 10 minutes (both sides derive independently from time).
- AES-256-GCM via OpenSSL EVP. Replay protection via seq window.

## 6. Anti-DPI summary

| Technique | Effect |
|---|---|
| No magic bytes / no fixed layout | signature DPI fails |
| Per-copy re-encryption + padding | duplicate detection fails, length analysis blurred |
| Inter-copy timing jitter | burst/timing fingerprinting weakened |
| Random padding 0–48 B | packet-size histogram flattened |
| Epoch key rotation | long-term statistical analysis fails |

## 7. Roles

- **Server (Linux)**: `kanki-server --listen :4000 --target 127.0.0.1:27015`
  Decapsulates and forwards to the game/app server; replies are encapsulated back.
- **Client (Android/Linux)**: `kanki-client --listen 127.0.0.1:5000 --server x.x.x.x:4000`
  Local app talks plain UDP to 127.0.0.1:5000; tunnel does the rest.

## 8. v0.2 additions

### Fake-TCP mode (`--faketcp`, Linux, root/CAP_NET_RAW)
Kanki wire packets are carried as payloads of crafted TCP segments
(IP_HDRINCL raw socket). To DPI/NAT the flow looks like a plain TCP stream
with plausible seq/ack progression and PSH+ACK data segments. Use when the
network blocks or throttles UDP. Android: needs root; without root use UDP mode.

### Auto-tune (`--autotune`)
Receiver measures real per-copy loss over sliding windows of 64 unique
packets (arrivals vs. expected = window × repeat). It maps loss to a new
repeat ( <5%→3, <15%→4, <25%→6, <40%→8, else 10 ) and announces it to the
peer with a 10x-multiplied CONTROL packet `TUNE:<n>`. The peer applies it
instantly. Result: minimal bandwidth on good links, maximal survival on bad
ones — always inside the user-allowed 3..10 range.

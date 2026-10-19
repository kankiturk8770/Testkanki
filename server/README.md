# KANKI — private anti-loss gaming tunnel

Tested: **50/50 packets delivered through a link dropping 50% of all packets**
(repeat=10 + FEC, loopback lab with lossy proxy).

## Build (Linux server / desktop client)

```
sudo apt install libssl-dev
make
```

## Run

Generate a shared key (same on both sides):

```
openssl rand -hex 32
```

Server (on your VPS, in front of the game/app server):

```
./kanki-server --listen :4000 --target 127.0.0.1:27015 --key <64hex> --repeat 6
```

Client (point your game/app at 127.0.0.1:5000):

```
./kanki-client --listen 127.0.0.1:5000 --server YOUR_VPS:4000 --key <64hex> --repeat 6
```

Both machines need a roughly correct clock (NTP): keys rotate every 10 minutes
from wall-clock time; up to ±10 minutes of skew is tolerated.

### Fake-TCP mode (`--faketcp`, root)

Use `--faketcp` on **both** sides. The kernel does not know about the fake
stream and answers it with TCP RSTs; drop them so middleboxes keep the flow:

```
# server (listen port 4000)
iptables -A OUTPUT -p tcp --sport 4000 --tcp-flags RST RST -j DROP
# client (any source port it picks, 40000-59999)
iptables -A OUTPUT -p tcp -d YOUR_VPS --dport 4000 --tcp-flags RST RST -j DROP
```

## Tuning

| Flag | Range | Default | Meaning |
|---|---|---|---|
| `--repeat` | 3–10 | 4 | copies of every packet (loss immunity vs. bandwidth) |
| `--fec-k` | 2–16 | 8 | data shards per FEC block (+1 parity) |
| `--no-fec` | — | off | disable FEC, multiplication only |
| `--jitter` | µs | 1500 | max inter-copy jitter (0 = back-to-back) |

Rules of thumb:
- Slightly lossy Wi-Fi (1–5%): `--repeat 3`, FEC on.
- Bad mobile link (10–30%): `--repeat 6`, FEC on.
- Disaster link (30–60%): `--repeat 10`, `--fec-k 12`.
- Bandwidth cost ≈ repeat × (1 + 1/k). repeat=10,k=8 → ~11x raw traffic.
  For gaming tick traffic (few KB/s) this is fine; don't torrent through it.

## Android client

The same `kanki-client.c` core compiles with the NDK (`make android`), or wrap it:
1. Android Studio project → JNI shim calling `kanki_client_main()`.
2. Run as a `VpnService`-less local forwarder, or via Termux directly:
   ```
   pkg install clang openssl && make kanki-client
   ./kanki-client --listen 127.0.0.1:5000 --server VPS:4000 --key <hex>
   ```

## Protocol details

See SPEC.md — AES-256-GCM, HKDF epoch rotation, per-copy re-encryption,
random padding, timing jitter, XOR-FEC with tail flush.

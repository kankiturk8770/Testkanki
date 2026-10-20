# KANKI VPN core (`kanki-vpnd`)

Multi-user IPv4 VPN server. Every device slot has its own key and tunnel IP;
every `port` line is a listener with its own repeat / FEC / jitter profile.
Install it with the one-line installer (see `../README.md`); the panel writes
`/etc/kanki/kanki.conf` and the core picks up changes to users, ports and MTU
by itself within about a second.

```
make            # needs libssl-dev
./kanki-vpnd --config /etc/kanki/kanki.conf --status-file /var/lib/kanki/status.txt
./kanki-vpnd --config FILE --check-config     # validate without opening TUN
```

Config:

```
tun kanki0
address 10.66.0.1/16
mtu 1280
port udp 4000 repeat=4 fec_k=8 fec=1 autotune=1 jitter=0
user NAME KEYHEX 10.66.0.2 - group=ACCOUNT quota=BYTES expires=UNIX_TIME
```

Changing `tun` or `address` needs a restart. Both machines need a roughly correct
clock (NTP): keys rotate every 10 minutes; ±10 minutes of skew is tolerated.

| Option | Range | Default | Meaning |
|---|---|---|---|
| `repeat` | 3–10 | 4 | copies of every packet (loss immunity vs. bandwidth) |
| `fec_k` | 2–16 | 8 | data shards per FEC block (+1 parity) |
| `fec` | 0/1 | 1 | XOR FEC recovery |
| `autotune` | 0/1 | 1 | adapt repeat to measured loss |
| `jitter` | µs | 0 | max inter-copy jitter |

Bandwidth cost ≈ repeat × (1 + 1/k). Fine for game tick traffic, not for bulk
downloads. `port faketcp N` carries the tunnel inside crafted TCP segments
(needs CAP_NET_RAW, Linux clients only). Protocol details: `SPEC.md`.

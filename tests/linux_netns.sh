#!/usr/bin/env bash
# Isolated real TUN/routing/NAT/TCP/UDP/DNS test. Exit 77 means missing host capabilities.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
if [[ $EUID -ne 0 || ! -c /dev/net/tun ]]; then echo 'SKIP: root, CAP_NET_ADMIN, network namespaces and /dev/net/tun are required'; exit 77; fi
for cmd in ip iptables python3; do command -v "$cmd" >/dev/null || { echo "SKIP: missing $cmd"; exit 77; }; done
S=kanki-s-$$; C=kanki-c-$$; W=kanki-w-$$; D=kanki-d-$$
TMP=$(mktemp -d)
PIDS=()
cleanup(){ for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; for n in "$C" "$S" "$W" "$D"; do ip netns delete "$n" 2>/dev/null || true; done; rm -rf "$TMP"; }
trap cleanup EXIT
ip netns add "$S" || { echo 'SKIP: cannot create network namespace'; exit 77; }
ip netns add "$C"; ip netns add "$W";ip netns add "$D"
ip link add sc0 type veth peer name cs0; ip link set sc0 netns "$S"; ip link set cs0 netns "$C"
ip link add sw0 type veth peer name ws0; ip link set sw0 netns "$S"; ip link set ws0 netns "$W"
ip link add sd0 type veth peer name ds0; ip link set sd0 netns "$S";ip link set ds0 netns "$D"
for n in "$S" "$C" "$W" "$D"; do ip -n "$n" link set lo up; done
ip -n "$S" address add 198.18.0.1/24 dev sc0; ip -n "$C" address add 198.18.0.2/24 dev cs0
ip -n "$S" address add 203.0.113.1/24 dev sw0; ip -n "$W" address add 203.0.113.2/24 dev ws0
ip -n "$S" link set sc0 up;ip -n "$C" link set cs0 up;ip -n "$S" link set sw0 up;ip -n "$W" link set ws0 up
ip -n "$S" address add 198.18.1.1/24 dev sd0;ip -n "$D" address add 198.18.1.2/24 dev ds0
ip -n "$S" link set sd0 up;ip -n "$D" link set ds0 up
ip netns exec "$C" python3 "$ROOT/tests/assert_no_leak.py" cs0 "$TMP/leak" > "$TMP/leak.log" 2>&1 & SNIFFER=$!;PIDS+=("$SNIFFER")
for ((i=0;i<50;i++));do [[ -f $TMP/leak.ready ]] && break;sleep .1;done
KEY2=$(python3 -c 'import secrets;print(secrets.token_hex(32))');printf '%s\n' "$KEY2" > "$TMP/key2"
KEY=$(python3 -c 'import secrets;print(secrets.token_hex(32))');printf '%s\n' "$KEY" > "$TMP/key"
cat > "$TMP/server.conf" <<EOF
tun kanki0
address 10.66.0.1/16
mtu 1280
port udp 4000 repeat=4 fec_k=8 fec=1 autotune=1 jitter=0
user test $KEY 10.66.0.2 - group=test quota=0
user second $KEY2 10.66.0.3 - group=test quota=0
EOF
make -C "$ROOT/server" all test-client >/dev/null
ip netns exec "$W" python3 "$ROOT/tests/echo_servers.py" > "$TMP/echo.log" 2>&1 & PIDS+=("$!")
ip netns exec "$S" "$ROOT/server/kanki-vpnd" --config "$TMP/server.conf" --status-file "$TMP/status" > "$TMP/server.log" 2>&1 & PIDS+=("$!")
for ((i=0;i<50;i++)); do ip -n "$S" link show kanki0 >/dev/null 2>&1 && break;sleep .1;done
ip netns exec "$S" env KANKI_WAN=sw0 bash "$ROOT/deploy/gateway.sh" apply
ip netns exec "$C" "$ROOT/tests/tools/kanki-vpn-client" --server 198.18.0.1 --key-file "$TMP/key" --ping
ip netns exec "$C" "$ROOT/tests/tools/kanki-vpn-client" --server 198.18.0.1 --key-file "$TMP/key" --address 10.66.0.2 > "$TMP/client.log" 2>&1 & FIRST_CLIENT=$!;PIDS+=("$FIRST_CLIENT")
for ((i=0;i<50;i++));do ip -n "$C" link show up dev kankic0 2>/dev/null | grep -q . && break;sleep .1;done
ip -n "$C" route add default dev kankic0
ip netns exec "$D" "$ROOT/tests/tools/kanki-vpn-client" --server 198.18.1.1 --key-file "$TMP/key2" --address 10.66.0.3 > "$TMP/second-client.log" 2>&1 & PIDS+=("$!")
for ((i=0;i<50;i++));do ip -n "$D" link show up dev kankic0 2>/dev/null | grep -q . && break;sleep .1;done
ip -n "$D" route add default dev kankic0
echo 'CONCURRENCY: two independent Linux VPN clients, distinct PSK/IP, shared account'
ip netns exec "$C" python3 "$ROOT/tests/probe_network.py" > "$TMP/first.json" & PROBE_FIRST=$!
ip netns exec "$D" python3 "$ROOT/tests/probe_network.py" > "$TMP/second.json" & PROBE_SECOND=$!
wait "$PROBE_FIRST";wait "$PROBE_SECOND"
cat "$TMP/first.json" "$TMP/second.json"
if command -v tc >/dev/null && ip netns exec "$S" tc qdisc add dev sc0 root netem delay 20ms 5ms loss 10% 2> "$TMP/tc.log"; then
  ip netns exec "$C" tc qdisc add dev cs0 root netem delay 20ms 5ms loss 10%
  echo 'IMPAIRMENT: kernel netem, 10% wire loss + 20±5ms delay each direction'
  ip netns exec "$C" python3 "$ROOT/tests/probe_network.py"
else
  echo 'IMPAIRMENT: netem unavailable; using deterministic userspace UDP loss/delay proxy'
  kill "$FIRST_CLIENT";wait "$FIRST_CLIENT" || true
  ip netns exec "$S" python3 "$ROOT/tests/loss_proxy.py" > "$TMP/proxy.log" 2>&1 & PIDS+=("$!")
  ip netns exec "$C" "$ROOT/tests/tools/kanki-vpn-client" --server 198.18.0.1 --port 4001 --key-file "$TMP/key" --address 10.66.0.2 > "$TMP/impaired-client.log" 2>&1 & PIDS+=("$!")
  for ((i=0;i<50;i++));do ip -n "$C" link show up dev kankic0 2>/dev/null | grep -q . && break;sleep .1;done
  ip -n "$C" route replace default dev kankic0
  ip netns exec "$C" python3 "$ROOT/tests/probe_network.py"
fi
touch "$TMP/leak.stop";wait "$SNIFFER";cat "$TMP/leak.log"
ps -o pid,rss,pcpu,etime -C kanki-vpnd
echo 'PASS: real Linux TUN, NAT, TCP, UDP, DNS, MTU and impaired-path tests'

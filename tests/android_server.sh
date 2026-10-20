#!/usr/bin/env bash
# Isolated fixture for emulator/device instrumentation. Run in a disposable capable container.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=${KANKI_DEVICE_FIXTURE:-/tmp/kanki-device}
mkdir -p "$TMP" /dev/net
[[ -c /dev/net/tun ]] || mknod /dev/net/tun c 10 200
make -C "$ROOT/server" -B LDLIBS='-Wl,-Bstatic -lcrypto -Wl,-Bdynamic -ldl -pthread'
ip netns add kanki-device-world
ip link add android-wan type veth peer name android-world
ip link set android-world netns kanki-device-world
ip address add 203.0.113.1/24 dev android-wan
ip link set android-wan up
ip -n kanki-device-world link set lo up
ip -n kanki-device-world address add 203.0.113.2/24 dev android-world
ip -n kanki-device-world link set android-world up
python3 -c 'import secrets; print(secrets.token_hex(32))' > "$TMP/key"
cat > "$TMP/server.conf" <<EOF
tun kanki0
address 10.66.0.1/16
mtu 1280
port udp 4000 repeat=4 fec_k=8 fec=1 autotune=1 jitter=0
user android $(cat "$TMP/key") 10.66.0.2 - group=android quota=0
EOF
ip netns exec kanki-device-world python3 "$ROOT/tests/echo_servers.py" > "$TMP/echo.log" 2>&1 &
"$ROOT/server/kanki-vpnd" --config "$TMP/server.conf" --status-file "$TMP/status" > "$TMP/engine.log" 2>&1 &
for ((i=0;i<50;i++));do ip link show kanki0 >/dev/null 2>&1 && break;sleep .1;done
KANKI_WAN=android-wan bash "$ROOT/deploy/gateway.sh" apply
touch "$TMP/ready"
wait

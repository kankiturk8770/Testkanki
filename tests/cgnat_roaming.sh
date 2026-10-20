#!/usr/bin/env bash
# Real network test of the failure seen on mobile networks: the operator's CGNAT
# gives the phone's UDP flow a new public port, or silently drops the flow.
# Topology: client ns -> "operator" router ns (random-port SNAT) -> server ns.
# The client is the Android app's own native code (tests/tools/jni_harness).
# usage: sudo bash tests/cgnat_roaming.sh [VPND_BINARY]
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
VPND=${1:-$ROOT/server/kanki-vpnd}
[[ $EUID -eq 0 && -e /dev/net/tun ]] && command -v conntrack >/dev/null || { echo 'SKIP: root, TUN and conntrack required'; exit 77; }
make -C "$ROOT/server" >/dev/null
J=$(dirname "$(readlink -f "$(command -v javac || command -v java)")")/../include
cc -O1 -I"$J" -I"$J/linux" -I"$ROOT/tests/tools" -I"$ROOT/server" "$ROOT/tests/tools/jni_harness.c" -lcrypto -lpthread -o "$ROOT/tests/tools/jni_harness" 2>/dev/null
T=$(mktemp -d); C=kcg-c$$; R=kcg-r$$; S=kcg-s$$
cleanup(){ for n in $C $R $S; do ip netns pids $n 2>/dev/null | xargs -r kill 2>/dev/null || true; done; sleep 0.3; for n in $C $R $S; do ip netns del $n 2>/dev/null || true; done; rm -rf "$T"; }
trap cleanup EXIT
[[ -n ${KEEP:-} ]] && trap "cp -r \"\$T\" $KEEP; cleanup" EXIT
for n in $C $R $S; do ip netns add $n; ip -n $n link set lo up; done
ip link add kcg-c type veth peer name kcg-rc; ip link set kcg-c netns $C; ip link set kcg-rc netns $R
ip link add kcg-s type veth peer name kcg-rs; ip link set kcg-s netns $S; ip link set kcg-rs netns $R
ip -n $C addr add 10.9.1.2/24 dev kcg-c; ip -n $C link set kcg-c up; ip -n $C route add default via 10.9.1.1
ip -n $R addr add 10.9.1.1/24 dev kcg-rc; ip -n $R link set kcg-rc up
ip -n $R addr add 198.20.0.1/24 dev kcg-rs; ip -n $R link set kcg-rs up
ip -n $S addr add 198.20.0.2/24 dev kcg-s; ip -n $S link set kcg-s up
ip netns exec $R sysctl -qw net.ipv4.ip_forward=1
ip netns exec $R iptables -t nat -A POSTROUTING -o kcg-rs -p udp -j SNAT --to-source 198.20.0.1:20000-60000 --random
KEY=$(openssl rand -hex 32)
printf 'tun kanki0\naddress 10.66.0.1/16\nmtu 1280\nport udp 9090\nuser cg-d1 %s 10.66.0.2\n' "$KEY" > "$T/conf"
ip netns exec $S "$VPND" --config "$T/conf" --status-file "$T/status" --events-file "$T/events" > "$T/vpnd.log" 2>&1 &
sleep 1
ip netns exec $C "$ROOT/tests/tools/jni_harness" 198.20.0.2 9090 "$KEY" kanki-c 30 > "$T/client.json" &
CLIENT=$!
for i in $(seq 50); do ip -n $C link show kanki-c >/dev/null 2>&1 && break; sleep 0.1; done
ip -n $C addr add 10.66.0.2/32 dev kanki-c; ip -n $C link set kanki-c mtu 1280 up; ip -n $C route add 10.66.0.1/32 dev kanki-c
# real traffic through the tunnel: 5 echoes per second to the server's tunnel address
ip netns exec $C ping -n -i 0.2 -W 1 -c 140 10.66.0.1 > "$T/ping.txt" 2>&1 &
PINGER=$!
sleep 6;  ip netns exec $R conntrack -D -p udp >/dev/null 2>&1 || true      # A: CGNAT remaps the public port
sleep 10; SPORT=$(ip netns exec $R conntrack -L -p udp 2>/dev/null | sed -n 's/.*src=10.9.1.2 dst=198.20.0.2 sport=\([0-9]*\).*/\1/p' | head -1)
ip netns exec $R iptables -I FORWARD -p udp -s 10.9.1.2 --sport "$SPORT" -j DROP   # B: operator blackholes the flow
wait $PINGER || true
wait $CLIENT || true
python3 - "$T/client.json" "$T/events" "$T/ping.txt" <<'PY'
import json,re,sys
got={int(m.group(1)) for m in re.finditer(r'icmp_seq=(\d+)',open(sys.argv[3]).read())}
def data_gap(lo,hi):  # longest run of unanswered echoes between seconds lo and hi
    run=best=0
    for seq in range(int(lo*5)+1,int(hi*5)+1):
        run=0 if seq in got else run+1; best=max(best,run)
    return best/5
rows=[json.loads(l) for l in open(sys.argv[1]) if l.startswith('{')]
def outage(lo,hi):
    down=[r['t'] for r in rows if lo<=r['t']<hi and r['silence_ms']>1500]
    return (max(down)-min(down)+0.5) if down else 0.0
a,b=outage(6,16),outage(16,40)
connected=[r for r in rows if r['state']==2]
remap,hole=data_gap(5,15),data_gap(15,28)
ok=remap<=1.0 and hole<=3.0
print(json.dumps({'result':'PASS' if ok else 'FAIL','tunnel_data_gap_after_port_remap_s':remap,'tunnel_data_gap_after_flow_blackhole_s':hole,
  'echoes_answered':f'{len(got)}/140','pong_outage_after_port_remap_s':a,'pong_outage_after_flow_blackhole_s':b,
  'client_port_moves':rows[-1]['hops'],'connected_samples':len(connected),'samples':len(rows),
  'server_events':[l.split(' ',3)[3].strip() for l in open(sys.argv[2])] if __import__('os').path.exists(sys.argv[2]) else []},ensure_ascii=False,indent=1))
sys.exit(0 if ok else 1)
PY

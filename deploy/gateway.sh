#!/usr/bin/env bash
# KANKI gateway helper. Explicit apply/stop; never changes firewall on inspection.
set -euo pipefail
MODE=${1:-check}
TUN=${KANKI_TUN:-kanki0}
SUBNET=${KANKI_SUBNET:-10.66.0.0/16}
WAN=${KANKI_WAN:-$(ip -4 route show default 2>/dev/null | awk 'NR==1 {for(i=1;i<=NF;i++) if($i=="dev") {print $(i+1); exit}}')}
CHAIN=KANKI_FORWARD
if [[ ! "$TUN" =~ ^[a-zA-Z0-9_.-]{1,15}$ || ! "$WAN" =~ ^[a-zA-Z0-9_.-]{1,15}$ || ! "$SUBNET" =~ ^[0-9.]+/[0-9]{1,2}$ ]]; then echo 'Invalid interface or subnet' >&2; exit 2; fi
check() {
  echo "TUN=$TUN WAN=$WAN SUBNET=$SUBNET"
  ip link show "$TUN" || true
  ip link show "$WAN" || true
  sysctl net.ipv4.ip_forward
  command -v iptables >/dev/null || echo 'iptables missing'
  echo 'No firewall changes made.'
}
if [[ $MODE == check ]]; then check; exit 0; fi
if [[ $EUID -ne 0 ]]; then echo 'Run as root' >&2; exit 1; fi
command -v iptables >/dev/null; command -v ip >/dev/null
if [[ $MODE == apply ]]; then
  ip link show "$TUN" >/dev/null || { echo "TUN $TUN not present: start kanki-vpnd first" >&2; exit 1; }
  ip link show "$WAN" >/dev/null
  if [[ $(sysctl -n net.ipv4.ip_forward) != 1 ]]; then sysctl -w net.ipv4.ip_forward=1; fi
  [[ $(sysctl -n net.ipv4.ip_forward) == 1 ]] || { echo 'IPv4 forwarding is disabled' >&2; exit 1; }
  iptables -N "$CHAIN" 2>/dev/null || true
  iptables -C FORWARD -j "$CHAIN" 2>/dev/null || iptables -I FORWARD 1 -j "$CHAIN"
  # Isolate clients even when another host rule allows forwarding between tunnel addresses.
  iptables -C "$CHAIN" -i "$TUN" -d "$SUBNET" -j DROP 2>/dev/null || iptables -A "$CHAIN" -i "$TUN" -d "$SUBNET" -j DROP
  iptables -C "$CHAIN" -i "$TUN" -o "$WAN" -s "$SUBNET" -j ACCEPT 2>/dev/null || iptables -A "$CHAIN" -i "$TUN" -o "$WAN" -s "$SUBNET" -j ACCEPT
  iptables -C "$CHAIN" -i "$WAN" -o "$TUN" -d "$SUBNET" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || iptables -A "$CHAIN" -i "$WAN" -o "$TUN" -d "$SUBNET" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  iptables -C "$CHAIN" -i "$TUN" -j DROP 2>/dev/null || iptables -A "$CHAIN" -i "$TUN" -j DROP
  iptables -t nat -C POSTROUTING -s "$SUBNET" -o "$WAN" -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s "$SUBNET" -o "$WAN" -j MASQUERADE
  echo 'Gateway IPv4 rules applied. IPv6 is not enabled.'
elif [[ $MODE == stop ]]; then
  iptables -t nat -D POSTROUTING -s "$SUBNET" -o "$WAN" -j MASQUERADE 2>/dev/null || true
  while iptables -C FORWARD -j "$CHAIN" 2>/dev/null; do iptables -D FORWARD -j "$CHAIN"; done
  iptables -F "$CHAIN" 2>/dev/null || true
  iptables -X "$CHAIN" 2>/dev/null || true
  echo 'KANKI firewall rules removed; ip_forward unchanged.'
else echo 'Usage: gateway.sh check|apply|stop' >&2; exit 2; fi

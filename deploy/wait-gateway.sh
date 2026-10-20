#!/usr/bin/env bash
set -euo pipefail
for ((i=0;i<50;i++)); do
  if ip link show "${KANKI_TUN:-kanki0}" >/dev/null 2>&1; then exec /opt/kanki/deploy/gateway.sh apply; fi
  sleep 0.1
done
echo 'TUN did not become ready' >&2
exit 1

#!/usr/bin/env bash
# Dedicated NEW node. Credentials are read from stdin, never from command arguments.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run as root on a new Debian/Ubuntu node' >&2;exit 1; }
KANKI_CONTROLLER_URL=${1:?Usage: sudo bash deploy/install-node.sh https://CONTROLLER < PRIVATE_TOKEN_FILE}
[[ $KANKI_CONTROLLER_URL =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || { echo 'HTTPS origin required' >&2;exit 2; }
[[ ! -e /etc/kanki-admin.env ]] || { echo 'Controller/local installation already exists on this host' >&2;exit 2; }
if [[ ${2:-} == --resume ]]; then
  [[ -f /etc/kanki-node.env ]] || { echo 'No node installation to resume' >&2;exit 2; }
  source /etc/kanki-node.env
  [[ $KANKI_CONTROLLER == "$KANKI_CONTROLLER_URL" ]] || { echo 'Controller origin must match existing identity' >&2;exit 2; }
  KANKI_NODE_CREDENTIAL=$KANKI_NODE_TOKEN
else
  [[ ! -e /etc/kanki-node.env && ! -e /var/lib/kanki/agent.json && ! -e /var/lib/kanki/credit.log ]] || { echo 'Existing node: use --resume, never reset durable identity/credit' >&2;exit 2; }
  IFS= read -r KANKI_NODE_CREDENTIAL || [[ -n ${KANKI_NODE_CREDENTIAL:-} ]]
fi
[[ $KANKI_NODE_CREDENTIAL =~ ^[A-Za-z0-9_-]{32,128}$ ]] || { echo 'Invalid credential' >&2;exit 2; }
ROOT=$(cd "$(dirname "$0")/.." && pwd)
apt-get update
apt-get install -y build-essential libssl-dev python3 iproute2 iptables ca-certificates
make -C "$ROOT/server" -B
id kanki >/dev/null 2>&1 || useradd --system --home /var/lib/kanki --shell /usr/sbin/nologin kanki
install -d -o root -g kanki -m 0770 /etc/kanki
install -d -o kanki -g kanki -m 0750 /var/lib/kanki
install -d -m 0755 /opt/kanki/agent /opt/kanki/deploy
install -m 0755 "$ROOT/server/kanki-vpnd" /usr/local/bin/
install -m 0644 "$ROOT/agent/kanki_agent.py" /opt/kanki/agent/
install -m 0755 "$ROOT/deploy/gateway.sh" "$ROOT/deploy/wait-gateway.sh" /opt/kanki/deploy/
umask 027
if [[ ! -e /etc/kanki-node.env ]]; then
cat > /etc/kanki-node.env <<EOF
KANKI_CONTROLLER=$KANKI_CONTROLLER_URL
KANKI_NODE_TOKEN=$KANKI_NODE_CREDENTIAL
KANKI_NODE_STATE=/var/lib/kanki/agent.json
KANKI_CONF=/etc/kanki/kanki.conf
KANKI_STATUS=/var/lib/kanki/status.txt
KANKI_CREDIT_LEDGER=/var/lib/kanki/credit.log
EOF
chown root:kanki /etc/kanki-node.env
chmod 0640 /etc/kanki-node.env
fi
install -m 0644 "$ROOT/deploy/kanki-vpnd.service" "$ROOT/deploy/kanki-agent.service" "$ROOT/deploy/kanki-gateway.service" /etc/systemd/system/
install -d -m 0755 /etc/systemd/system/kanki-vpnd.service.d
cat > /etc/systemd/system/kanki-vpnd.service.d/node.conf <<'EOF'
[Unit]
After=kanki-agent.service
Wants=kanki-agent.service
[Service]
ExecStart=
ExecStart=/usr/local/bin/kanki-vpnd --config /etc/kanki/kanki.conf --status-file /var/lib/kanki/status.txt --credit-ledger /var/lib/kanki/credit.log
EOF
systemctl daemon-reload
if [[ ${2:-} == --resume ]]; then systemctl stop kanki-agent.service; fi
# Bootstrap must obtain/validate a signed lease before starting the engine.
set -a
source /etc/kanki-node.env
set +a
runuser -u kanki --preserve-environment -- python3 /opt/kanki/agent/kanki_agent.py --once
systemctl enable --now kanki-agent.service kanki-vpnd.service kanki-gateway.service
printf '%s\n' 'Node installed. Assign device slots in the controller. Allow the configured UDP port.' 'Back up agent.json, credit.log and node credential together; never restore an older credit journal.'

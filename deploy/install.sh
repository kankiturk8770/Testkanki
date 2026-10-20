#!/usr/bin/env bash
# Installs or upgrades KANKI on a Debian/Ubuntu server: the VPN core (kanki-vpnd),
# the web panel and an automatic HTTPS certificate for DOMAIN (Caddy + Let's Encrypt).
# Existing users, keys and configuration are preserved.
#   sudo bash deploy/install.sh DOMAIN [UDP_PORT]
# Optional environment: KANKI_EMAIL (certificate contact), KANKI_CLUSTER=1 (central
# controller for several nodes, see docs/CLUSTER_FA.md), KANKI_NO_TLS=1 (skip Caddy).
set -euo pipefail
usage() { echo 'Usage: sudo bash deploy/install.sh DOMAIN [UDP_PORT]' >&2; exit 2; }
[[ $EUID -eq 0 ]] || { echo 'Run as root (sudo).' >&2; exit 1; }
DOMAIN=${1:-}
UDP_PORT=${2:-${KANKI_PORT:-4000}}
[[ $DOMAIN =~ ^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$ ]] || usage
[[ $UDP_PORT =~ ^[0-9]{1,5}$ ]] && (( UDP_PORT >= 1 && UDP_PORT <= 65535 )) || { echo 'UDP_PORT must be 1-65535' >&2; exit 2; }
[[ -z ${KANKI_EMAIL:-} || ${KANKI_EMAIL} =~ ^[^[:space:]@]+@[^[:space:]@]+$ ]] || { echo 'Invalid KANKI_EMAIL' >&2; exit 2; }
command -v systemctl >/dev/null || { echo 'systemd is required' >&2; exit 1; }
ROOT=$(cd "$(dirname "$0")/.." && pwd)
ENV_FILE=/etc/kanki-admin.env

# Mode checks happen before anything is changed on the host.
[[ ! -e /etc/kanki-node.env ]] || { echo 'This host is a cluster node (install-node.sh); use a separate host for the panel.' >&2; exit 2; }
if [[ -e $ENV_FILE ]]; then
  CURRENT_CLUSTER=$(grep -qx 'KANKI_CLUSTER=1' "$ENV_FILE" && echo 1 || echo 0)
  if [[ -z ${KANKI_CLUSTER+x} ]]; then KANKI_CLUSTER=$CURRENT_CLUSTER; fi
  if [[ ${KANKI_CLUSTER} == 1 && $CURRENT_CLUSTER != 1 ]]; then
    echo 'Existing single-server install: stop services and follow the offline migration in docs/CLUSTER_FA.md first.' >&2; exit 2
  fi
fi
KANKI_CLUSTER=${KANKI_CLUSTER:-0}

if [[ -z ${KANKI_NO_TLS:-} ]]; then
  SERVER_IP=$(curl -4fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)
  DOMAIN_IPS=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || true)
  if [[ -z $DOMAIN_IPS ]]; then
    echo "WARNING: $DOMAIN does not resolve yet. Point its A record to this server, otherwise the certificate cannot be issued." >&2
  elif [[ -n $SERVER_IP && " $DOMAIN_IPS" != *" $SERVER_IP "* ]]; then
    echo "WARNING: $DOMAIN resolves to $DOMAIN_IPS but this server is $SERVER_IP. The certificate needs the A record to point here (DNS only, no proxy)." >&2
  fi
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y build-essential libssl-dev python3 iproute2 iptables ca-certificates curl gnupg
if [[ -z ${KANKI_NO_TLS:-} ]] && ! command -v caddy >/dev/null; then
  install -d -m 0755 /usr/share/keyrings
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))' || { echo 'Python 3.9 or newer is required (Debian 11+ / Ubuntu 22.04+).' >&2; exit 1; }
make -C "$ROOT/server" -B
id kanki >/dev/null 2>&1 || useradd --system --home /var/lib/kanki --shell /usr/sbin/nologin kanki
install -d -o root -g kanki -m 0770 /etc/kanki
install -d -o kanki -g kanki -m 0750 /var/lib/kanki
install -d -m 0755 /opt/kanki/admin /opt/kanki/deploy
install -m 0755 "$ROOT/server/kanki-vpnd" /usr/local/bin/
# Earlier releases installed separate relay/client programs; they are no longer used.
rm -f /usr/local/bin/kanki-server /usr/local/bin/kanki-client /usr/local/bin/kanki-vpn-client
install -m 0644 "$ROOT/admin/kanki_admin.py" "$ROOT/admin/kanki_cluster.py" "$ROOT/admin/index.html" "$ROOT/admin/app.js" "$ROOT/admin/style.css" /opt/kanki/admin/
install -m 0755 "$ROOT/deploy/gateway.sh" "$ROOT/deploy/wait-gateway.sh" /opt/kanki/deploy/
if [[ ! -e /etc/kanki/kanki.conf ]]; then
  sed "s/^port udp 4000 /port udp $UDP_PORT /" "$ROOT/deploy/kanki.conf.example" > /etc/kanki/kanki.conf
  chown kanki:kanki /etc/kanki/kanki.conf; chmod 0640 /etc/kanki/kanki.conf
fi

FRESH=0
if [[ ! -e $ENV_FILE ]]; then
  FRESH=1
  umask 027
  TOKEN=$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')
  cat > "$ENV_FILE" <<EOF
KANKI_ADMIN_TOKEN=$TOKEN
KANKI_ADMIN_DB=/var/lib/kanki/admin.sqlite3
KANKI_CONF=/etc/kanki/kanki.conf
KANKI_STATUS=/var/lib/kanki/status.txt
KANKI_PUBLIC_HOST=$DOMAIN
KANKI_PUBLIC_URL=https://$DOMAIN
KANKI_PORT=$UDP_PORT
KANKI_ADMIN_BIND=127.0.0.1
KANKI_ADMIN_PORT=8765
KANKI_CLUSTER=$KANKI_CLUSTER
EOF
  chown root:kanki "$ENV_FILE"
  chmod 0640 "$ENV_FILE"
  umask 022
fi

install -m 0644 "$ROOT/deploy/kanki-vpnd.service" "$ROOT/deploy/kanki-admin.service" "$ROOT/deploy/kanki-gateway.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable kanki-admin.service
systemctl restart kanki-admin.service
if [[ $KANKI_CLUSTER == 1 ]]; then
  systemctl disable --now kanki-gateway.service kanki-vpnd.service 2>/dev/null || true
else
  systemctl enable kanki-vpnd.service kanki-gateway.service
  systemctl restart kanki-vpnd.service
  systemctl restart kanki-gateway.service
fi

if [[ -z ${KANKI_NO_TLS:-} ]]; then
  CADDYFILE=/etc/caddy/Caddyfile
  if [[ -e $CADDYFILE ]] && ! grep -q '^# Managed by KANKI' "$CADDYFILE"; then cp -a "$CADDYFILE" "$CADDYFILE.before-kanki"; fi
  EMAIL_LINE=''
  [[ -z ${KANKI_EMAIL:-} ]] || EMAIL_LINE=$'\temail '"$KANKI_EMAIL"
  cat > "$CADDYFILE" <<EOF
# Managed by KANKI deploy/install.sh. Re-running the installer rewrites this file.
{
$EMAIL_LINE
	# HTTP/3 off: UDP 443 stays free for a KANKI listener.
	servers {
		protocols h1 h2
	}
}

$DOMAIN {
	# No access log: /sub/ URLs are secret credentials.
	reverse_proxy 127.0.0.1:8765
	header Strict-Transport-Security "max-age=31536000"
}
EOF
  caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null
  systemctl enable caddy.service
  systemctl reload caddy.service 2>/dev/null || systemctl restart caddy.service
fi

if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  [[ $KANKI_CLUSTER == 1 || $FRESH == 0 ]] || ufw allow "$UDP_PORT/udp" >/dev/null
fi

TOKEN=$(sed -n 's/^KANKI_ADMIN_TOKEN=//p' "$ENV_FILE")
echo
echo "KANKI is installed."
echo "  Panel:        https://$DOMAIN"
echo "  Admin token:  $TOKEN   (also in $ENV_FILE)"
if [[ $KANKI_CLUSTER == 1 ]]; then
  echo '  Mode:         cluster controller (add nodes in the panel, see docs/CLUSTER_FA.md)'
elif [[ $FRESH == 1 ]]; then
  echo "  VPN port:     UDP $UDP_PORT (open it in your provider's firewall; ports added in the panel too)"
else
  echo '  VPN ports:    unchanged; manage them in the panel under server profiles'
fi
echo 'Create a user in the panel, copy its subscription link and import it in the Android app.'

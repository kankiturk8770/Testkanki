#!/usr/bin/env bash
# One-line install from GitHub:
#   curl -fsSL https://raw.githubusercontent.com/kankiturk8770/Testkanki/main/install.sh | sudo bash -s -- vpn.example.com
# Optional second argument: VPN UDP port (default 4000). Optional environment:
# KANKI_EMAIL, KANKI_REPO, KANKI_BRANCH, KANKI_CLUSTER=1 (see deploy/install.sh).
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run as root: ... | sudo bash -s -- DOMAIN [UDP_PORT]' >&2; exit 1; }
[[ -n ${1:-} ]] || { echo 'Usage: ... | sudo bash -s -- DOMAIN [UDP_PORT]' >&2; exit 2; }
REPO=${KANKI_REPO:-https://github.com/kankiturk8770/Testkanki.git}
BRANCH=${KANKI_BRANCH:-main}
SRC=/opt/kanki/src
HERE=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)
if [[ -n $HERE && -f $HERE/deploy/install.sh && -f $HERE/server/kanki-vpnd.c ]]; then
  exec bash "$HERE/deploy/install.sh" "$@"
fi
export DEBIAN_FRONTEND=noninteractive
command -v git >/dev/null || { apt-get update; apt-get install -y git ca-certificates; }
if [[ -d $SRC/.git ]]; then
  git -C "$SRC" fetch --depth 1 origin "$BRANCH"
  git -C "$SRC" checkout -q -f -B "$BRANCH" FETCH_HEAD
else
  rm -rf "$SRC"
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$SRC"
fi
exec bash "$SRC/deploy/install.sh" "$@"

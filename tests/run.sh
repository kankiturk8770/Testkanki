#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BUILD=$(mktemp -d)
trap 'rm -rf "$BUILD"' EXIT
make -C "$ROOT/server" -B
cc -O1 -g -fsanitize=address,undefined -I"$ROOT/tests/fixtures/v0.2" "$ROOT/tests/test_protocol.c" -lcrypto -o "$BUILD/baseline"
"$BUILD/baseline"
for version in v0.2 current; do
  include="$ROOT/server"
  if [[ $version == v0.2 ]]; then include="$ROOT/tests/fixtures/v0.2"; fi
  cc -O1 -I"$include" "$ROOT/tests/interoperability.c" -lcrypto -o "$BUILD/$version"
done
"$BUILD/v0.2" seal > "$BUILD/old.wire"
"$BUILD/current" open < "$BUILD/old.wire"
"$BUILD/current" seal > "$BUILD/new.wire"
"$BUILD/v0.2" open < "$BUILD/new.wire"
for name in protocol vpnd hardening credit; do
  cc -O1 -g -fsanitize=address,undefined -fno-omit-frame-pointer -I"$ROOT/server" "$ROOT/tests/test_$name.c" -lcrypto -o "$BUILD/test_$name"
  "$BUILD/test_$name"
done
python3 "$ROOT/tests/test_admin.py"
python3 "$ROOT/tests/test_config.py"
python3 "$ROOT/tests/test_cluster.py"
python3 "$ROOT/tests/test_agent.py"
python3 "$ROOT/tests/test_migration.py"
for file in kanki.h kanki_link.h kanki_faketcp.h; do cmp "$ROOT/tests/fixtures/v0.3/$file" "$ROOT/server/$file"; cmp "$ROOT/server/$file" "$ROOT/client-android/app/src/main/cpp/$file"; done
for file in "$ROOT"/deploy/*.sh "$ROOT"/tests/*.sh "$ROOT"/client-android/build-openssl.sh; do bash -n "$file"; done
if command -v node >/dev/null; then node --check "$ROOT/admin/app.js"; fi
echo 'PASS: all local checks; real TUN and Android device tests are separate.'

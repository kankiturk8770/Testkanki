#!/usr/bin/env bash
# Build a static libcrypto for Android, for the JNI core (linked into libkanki.so,
# so nothing extra has to be packaged in the APK).
#   usage: ANDROID_NDK_ROOT=/path/to/ndk ./build-openssl.sh [PREFIX] [ABI]
#   then:  ./gradlew assembleDebug -POPENSSL_ROOT=PREFIX
set -euo pipefail
PREFIX=${1:-$HOME/openssl-android}
ABI=${2:-arm64-v8a}
VER=${OPENSSL_VERSION:-3.5.4}
API=26                                   # = minSdk
: "${ANDROID_NDK_ROOT:?set ANDROID_NDK_ROOT to your NDK directory}"
case "$ABI" in
    arm64-v8a)   TARGET=android-arm64 ;;
    armeabi-v7a) TARGET=android-arm ;;
    x86_64)      TARGET=android-x86_64 ;;
    x86)         TARGET=android-x86 ;;
    *) echo "unknown ABI $ABI" >&2; exit 1 ;;
esac
HOST_TAG=$(uname -s | tr '[:upper:]' '[:lower:]')-x86_64
export PATH="$ANDROID_NDK_ROOT/toolchains/llvm/prebuilt/$HOST_TAG/bin:$PATH"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
ARCHIVE="openssl-$VER.tar.gz"
URL="https://github.com/openssl/openssl/releases/download/openssl-$VER/$ARCHIVE"
curl -fsSL --retry 2 "$URL" -o "$WORK/$ARCHIVE"
EXPECTED=$(curl -fsSL --retry 2 "$URL.sha256" | awk '{print $1}')
[[ $EXPECTED =~ ^[a-fA-F0-9]{64}$ ]] || { echo 'Invalid upstream checksum' >&2; exit 1; }
printf '%s  %s\n' "$EXPECTED" "$WORK/$ARCHIVE" | sha256sum -c -
tar xzf "$WORK/$ARCHIVE" -C "$WORK"
cd "$WORK/openssl-$VER"
./Configure "$TARGET" -D__ANDROID_API__=$API no-shared no-tests -fPIC \
    --prefix="$PREFIX" --libdir=lib
make -j"$(nproc 2>/dev/null || echo 4)" build_libs
make install_dev
echo "OpenSSL $VER for $ABI installed in $PREFIX"

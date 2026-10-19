# KANKI Tunnel — Android app

Android client for the KANKI protocol (see kanki-core.zip / SPEC.md).
UI: server, ports, PSK, repeat slider (3–10), FEC toggle, auto-tune toggle.
Runs the same C core as the desktop client on a native thread inside a
foreground service — the tunnel survives screen-off.

## How it works

Your game/app talks plain UDP to `127.0.0.1:<localPort>`. The app tunnels it
to the server with multiplication + FEC + AES-256-GCM. No VpnService needed
for apps that let you set a custom server address. For system-wide capture,
extend this project with a VpnService that forwards to 127.0.0.1:<localPort>.

## Build

1. Build a static OpenSSL (libcrypto) for Android once (needs NDK 26.3.11579264):
   ```
   ANDROID_NDK_ROOT=$ANDROID_HOME/ndk/26.3.11579264 ./build-openssl.sh $HOME/openssl-android arm64-v8a
   ```
2. Build the APK (or open this folder in Android Studio and add
   `OPENSSL_ROOT=/home/you/openssl-android` to `gradle.properties`):
   ```
   ./gradlew assembleDebug -POPENSSL_ROOT=$HOME/openssl-android
   ```
   The APK is built for arm64-v8a (the ABI OpenSSL was built for).

3. Install: `adb install app/build/outputs/apk/debug/app-debug.apk`

## Notes

- Get the PSK from your server setup: `openssl rand -hex 32` (same both sides).
- Fake-TCP mode is Linux-server-side (needs root); Android uses UDP mode.
  On rooted devices the same core supports it — left as an exercise flag.
- Tested core: 50/50 packets through 50% loss (repeat=10 + FEC).

# KANKI Android 0.5.0

Android 8+ ARM64, compile/target SDK 34, JDK 17, NDK 26.3.11579264. Build OpenSSL for Android with `build-openssl.sh PREFIX arm64-v8a`, then `./gradlew assembleDebug assembleDebugAndroidTest lintDebug -POPENSSL_ROOT=PREFIX`.

The app imports version-1 KANKI HTTPS subscriptions, supports full-device IPv4 VPN and selected-app Gaming Smart. Server, port and key come from the subscription; manual settings are under "advanced". It does not import Xray subscriptions. IPv6 is captured and dropped. See `../docs/INSTALL_FA.md` for Google service routing, per-device profile selection, always-on/lockdown, build details and instrumentation commands.

Java owns TUN; native shutdown joins the worker before Java closes its descriptor. Native status becomes connected only after an authenticated PONG. Transport sockets are protected and server DNS is resolved over an underlying non-VPN Network. Secrets are kept in memory; package selections are saved. Three instrumentation tests passed on AOSP API 30 x86_64, including a real Linux-server TUN/UDP/DNS/stop test. Physical ARM64 phone, Gaming/Google login, private DNS and network handover remain unverified. Use `-PKANKI_ABI=x86_64` with matching OpenSSL to build the emulator ABI.

# KANKI Protocol v0.2 — full package

- server/          Linux server + desktop client (C/OpenSSL), Makefile + CMakeLists (prebuilt binaries: CI artifacts)
- client-android/  Android Studio project (UI + foreground service + JNI core)
- .github/workflows/build.yml  CI: auto-builds Linux binaries + Android APK on push
  (download them from the run's "Artifacts": kanki-linux-x86_64, kanki-android-apk)

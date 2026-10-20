# Third-party components in supplied builds

- OpenSSL, developed by the OpenSSL Project (https://www.openssl.org/). Android links OpenSSL 3.5.4; supplied Linux binaries link the Ubuntu-maintained 3.0.2-0ubuntu1.30 archive. Apache License 2.0 is included in `Apache-2.0.txt`; distribution copyright information is in `openssl-linux-copyright.txt`. Upstream source: https://github.com/openssl/openssl.
- AndroidX AppCompat and AndroidX test libraries, The Android Open Source Project, Apache License 2.0. https://android.googlesource.com/platform/frameworks/support/.
- The Gradle wrapper, Gradle Inc., Apache License 2.0. https://github.com/gradle/gradle.
- Linux binaries dynamically depend on the host GNU C Library; it is not bundled. Android system libraries are not bundled.

The project itself has no newly assigned license; the original project owner's licensing decisions are preserved.

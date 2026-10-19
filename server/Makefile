CC      ?= gcc
CFLAGS  ?= -O2 -Wall
LDLIBS   = -lcrypto

all: kanki-server kanki-client kanki-vpnd

kanki-server: kanki-server.c kanki.h kanki_link.h kanki_faketcp.h
	$(CC) $(CFLAGS) -o $@ kanki-server.c $(LDLIBS)

kanki-client: kanki-client.c kanki.h kanki_link.h kanki_faketcp.h
	$(CC) $(CFLAGS) -o $@ kanki-client.c $(LDLIBS)

kanki-vpnd: kanki-vpnd.c kanki.h kanki_link.h kanki_faketcp.h
	$(CC) $(CFLAGS) -o $@ kanki-vpnd.c $(LDLIBS)

# Android (NDK):  make android NDK=/path/to/ndk ABI=arm64-v8a
# Requires OpenSSL built for Android, or swap to mbedTLS.
android:
	$(NDK)/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android30-clang \
		$(CFLAGS) -o kanki-client-android kanki-client.c -lcrypto

clean:
	rm -f kanki-server kanki-client kanki-vpnd kanki-client-android

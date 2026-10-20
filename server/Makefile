CC      ?= gcc
CFLAGS  ?= -O2 -Wall
LDLIBS   = -lcrypto

all: kanki-vpnd

kanki-vpnd: kanki-vpnd.c kanki_credit.h kanki.h kanki_link.h kanki_faketcp.h
	$(CC) $(CFLAGS) -o $@ kanki-vpnd.c $(LDLIBS)

# Test-only Linux client used by tests/linux_netns.sh and tests/cluster_netns.py.
test-client: ../tests/tools/kanki-vpn-client.c ../tests/tools/kanki_vpnc.h kanki.h kanki_link.h kanki_faketcp.h
	$(CC) $(CFLAGS) -I. -o ../tests/tools/kanki-vpn-client ../tests/tools/kanki-vpn-client.c $(LDLIBS)

clean:
	rm -f kanki-vpnd ../tests/tools/kanki-vpn-client

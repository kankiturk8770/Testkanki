# Test entry points

- `bash tests/run.sh`: original/current protocol regressions with ASan/UBSan, old/new wire interoperability, hardened input cases, mocked-TUN vpnd datapath integration, panel HTTP tests, config rejection, shared-header equality and syntax checks.
- `python3 tests/test_panel_browser.py`: optional Playwright/Chromium UI test; screenshots use explicitly synthetic accounts/traffic.
- `sudo bash tests/linux_netns.sh`: real TUN, forwarding/NAT, two clients, TCP/UDP/DNS, MTU/fragmentation, physical-interface leakage observation and impaired UDP path. Requires root/capabilities, iptables and TUN. Exit 77 is a skip, not a pass. Uses netem if the kernel supports it; otherwise uses the seeded Python UDP impairment fixture. Deletes only namespaces/processes created by the test.
- `benchmark_core.c`: heap/FEC allocation and crypto CPU microbenchmark; not a network capacity test.
- `client-android/app/src/androidTest/`: two device validation tests and one optional real-server integration test; compile with `assembleDebugAndroidTest`, run on a consented ARM64 device.

`tests/Dockerfile` builds an Ubuntu 22.04 test image. Network namespace tests need extra capabilities; ordinary unit tests do not. In a managed proxy environment, pass the platform CA as a BuildKit `proxy_ca` secret. A namespace-capable isolated test container can be launched with NET_ADMIN and SYS_ADMIN and an appropriate local AppArmor policy. The container also needs `/dev/net/tun`; a test container may create the standard character device (major 10, minor 200) when the kernel supports it. Do not use host networking or run test echo fixtures on the public Internet.

See `../docs/TEST_REPORT_FA.md` for actual executed results and unverified Android/VPS behavior. 
Cluster checks: `python3 tests/test_cluster.py`, `python3 tests/test_agent.py`, `python3 tests/test_migration.py`, and optional Playwright `python3 tests/test_panel_cluster.py`. Real HTTPS/two-node/TUN quota + crash integration: `sudo python3 tests/cluster_netns.py` in a disposable capable container. `tests/android_server.sh` provisions an isolated emulator fixture and must only run in a disposable root/capable container, with only its VPN UDP listener published.

`tests/tools/kanki-vpn-client` is a test-only Linux client (`make -C server test-client`); it is not installed.

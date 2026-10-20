# Linux deployment

`../install.sh DOMAIN [UDP_PORT]` (or the one-line `curl ... | sudo bash -s -- DOMAIN`)
fetches the source and runs `install.sh` here: it builds and installs the VPN core,
the panel, systemd units, NAT rules and Caddy for automatic HTTPS. Re-running it
upgrades and keeps all users and configuration. See `../docs/INSTALL_FA.md`.

- `gateway.sh check|apply|stop`: dedicated IPv4 forwarding/NAT chain and client isolation; never flushes the whole firewall.
- `install-node.sh`: extra node for the optional cluster mode, see `../docs/CLUSTER_FA.md`.

# KANKI management panel

Run `kanki_admin.py` with `KANKI_ADMIN_TOKEN` (random, >=32 characters), `KANKI_ADMIN_DB`, `KANKI_CONF`, `KANKI_STATUS`, `KANKI_PUBLIC_HOST` and `KANKI_PUBLIC_URL`. Bind is loopback by default. Use the provided installer/systemd service and a TLS proxy for deployment; see `../docs/INSTALL_FA.md`.

The public shell is `/`; API requests use `Authorization: Bearer TOKEN`. Routes: `/api/status`, `/api/users`, `/api/users/NAME` (PATCH/DELETE), `/api/users/NAME/rotate` (POST), `/api/servers` (GET/POST), `/api/servers/ID` (DELETE), `/api/audit`. Public credential-bearing subscription: `/sub/TOKEN` returns versioned KANKI JSON profiles. Profile secrets are never included in `/api/users`.

Quota is enforced by the updated vpnd per account across device slots. Expiry is UTC. Connections are provisioned device slots with unique addresses and keys. In local mode server profiles are connection metadata. Set `KANKI_CLUSTER=1` for node management, signed pull agents, global quota escrow, lease-based slot assignment and ACK-gated subscriptions. See `../docs/CLUSTER_FA.md`; routes include `/api/nodes`, `/api/devices/ID/move` and the separately authenticated `/api/agent/sync`. Do not expose this stdlib HTTP server directly to the Internet.

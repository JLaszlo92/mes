# Adding an edge node

Every device has its own client certificate from the **device CA** (the
offline key on the admin laptop). A node connects to the broker only if (1)
its certificate is valid and (2) `/etc/mosquitto/acl.conf` has a block for its
name. Three places are involved; none of the scripts needs the CA key on a node.

| # | Where | What |
|---|---|---|
| 1 | laptop | `ops/onboarding/new-edge-node.sh <name> [broker-host]` — issues the certificate, writes `bundle-<name>.tar.gz` (contains the private key) |
| 2 | node-dc | `ops/onboarding/mosquitto-device-acl.sh add <name>` — adds the ACL block and reloads Mosquitto |
| 3 | MES UI | create the edge node with the **same name**; copy the token (shown once); assign machines/channels |
| 4 | the new node | get the bundle, run `./install-on-node.sh`, paste the token |
| 5 | cleanup | delete the bundle from the laptop and from the node |

The licence limits the number of edge nodes: step 3 is refused when
`limits.edgeNodes` is reached (see `docs/LICENSING.md`).

## Step 4 in detail (the node)

Prerequisites: Node.js, and the edge agent built from a release tag:

```bash
git clone https://github.com/JLaszlo92/mes.git ~/mes && cd ~/mes
git checkout edge-agent-v3            # use the latest edge-agent-v* tag
pnpm install --frozen-lockfile && pnpm --filter @mes/edge-agent build
```
(`docs/EDGE_AGENT_RELEASES.md` lists the tags.) Then, from the bundle
directory: `./install-on-node.sh`. It checks the certificate (name, expiry,
key pair), writes `/etc/mes/mqtt-client/{cert,key}.pem`, `/etc/ssl/mes-ca.crt`,
`/etc/mes/edge-node.env` (token, `0600`) and `mes-edge-node.service`, tests a
mutual-TLS connection to the broker (8884), and starts the service. If the
TLS test fails it installs everything but does **not** start the service.
Re-running on an installed node needs `--force`.

After a restart the backend may answer `409 another instance of this edge
node is already active` for 1–2 minutes (session lease): that is normal.

## Revoking a node

```bash
ops/onboarding/mosquitto-device-acl.sh remove <name>     # on node-dc
```
The node can no longer publish or receive anything once it reconnects (for an
emergency also `systemctl restart mosquitto`). Then delete the edge node in
the UI (this also invalidates its token). The certificate itself stays valid
until it expires; there is no CRL yet. See `docs/INCIDENT_RESPONSE.md`.

## Notes

- Names: lowercase letters, digits and `-`; `backend` and `admin-laptop` are
  reserved and never touched by `remove`.
- The unit runs as `root` like the existing node-gate; a dedicated user is on
  the hardening list.
- node-gate predates these scripts: its unit has historical drop-ins
  (`override.conf`, `mtls.conf`) with the same effective values.
- Certificates last 365 days: renew before expiry (re-issue with
  `mes-ca.sh issue-device`, replace `cert.pem`/`key.pem`, restart the service).

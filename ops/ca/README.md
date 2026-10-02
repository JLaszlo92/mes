# Internal CA (TLS for the MES pilot)

`mes-ca.sh` creates a small root CA and issues TLS **server** certificates
(ECDSA P-256, 1 year). Run it on an admin machine, never on node-dc.
Default CA directory: `~/mes-ca` (`MES_CA_DIR` overrides). Keep it out of git.

```bash
./mes-ca.sh init                       # once; asks for a passphrase
./mes-ca.sh issue mosquitto DNS:mes.pilot.internal,IP:192.168.60.141
./mes-ca.sh issue proxy     DNS:mes.pilot.internal,IP:192.168.60.141
./mes-ca.sh issue postgres  DNS:localhost,IP:127.0.0.1,DNS:mes.pilot.internal
./mes-ca.sh check ~/mes-ca/issued/mosquitto/cert.pem   # exit 2 if < 30 days left
```

Each `issued/<name>/` holds `cert.pem`, `key.pem` (secret) and `ca.crt` (public).

- **SANs must contain every name/IP a client connects with.** The Postgres
  cert needs `DNS:localhost` while the backend connects to `localhost`
  (`sslmode=verify-full` checks the name).
- `mes.pilot.internal` is a placeholder; use the real name once chosen.
- **Renewal:** certs last 365 days. Set a calendar reminder ~30 days
  before expiry, re-issue, copy to the node, restart the service.
- **Root key:** encrypted, stored offline. If it is lost or exposed, build a
  new CA and replace every certificate and every distributed `ca.crt`.
  Add this case to `INCIDENT_RESPONSE.md` section 5.2.

## Mosquitto server certificate setup (historical: the first TLS cutover)

The current broker configuration (single mTLS listener on 8884, device CA,
ACL) is in `ops/mosquitto/`; the steps below describe how the server
certificate was first installed.

1. Copy `cert.pem`, `key.pem`, `ca.crt` to `/etc/mosquitto/certs/`; key
   `0640 root:mosquitto`, `cert.pem` and `ca.crt` `0644` (the broker runs as
   user `mosquitto`; `scp` keeps the CA's strict 0600 otherwise and the broker
   fails with "Unable to load CA certificates ... Permission denied").
2. Add a second listener next to the existing 1883 one:
   ```
   listener 8883
   cafile   /etc/mosquitto/certs/ca.crt
   certfile /etc/mosquitto/certs/cert.pem
   keyfile  /etc/mosquitto/certs/key.pem
   tls_version tlsv1.2
   ```
3. Backend: `MQTT_URL=mqtts://…:8883` plus the CA (`NODE_EXTRA_CA_CERTS`
   or the client's `ca` option). Edge agent on node-gate: the same, with
   `ca.crt` copied there. Verify data flows.
4. Remove the 1883 listener only when nothing uses it any more (check
   the broker log), then block 1883 at the firewall.

## Where each certificate is used (pilot, node-dc)

| Name | Used by | Install |
|---|---|---|
| `mosquitto` | MQTT listener 8883 | `/etc/mosquitto/certs/` (see above); restart Mosquitto |
| `proxy` | nginx, 443 (`ops/proxy/mes-nginx.conf`) | `/etc/nginx/certs/{cert,key}.pem`; `nginx -t && systemctl reload nginx` |
| `postgres` | Postgres 17 (`conf.d/mes-tls.conf`) | `/etc/postgresql/17/main/certs/` owned by `postgres`, key `0600`; `systemctl reload postgresql@17-main` |

Clients trust the public `ca.crt` (`/etc/ssl/mes-ca.crt` on node-dc and
node-gate; `MQTT_CA_FILE` for MQTT, `NODE_EXTRA_CA_CERTS` for HTTPS and
Postgres). Browsers and terminal tablets need the same `ca.crt` installed.
To renew, move the old `issued/<name>` directory away, run `issue` again
and replace the files as above. All three certificates expire together.

## Device CA (client certificates, per-device identity)

A second, **separate** CA (`~/mes-device-ca`, `MES_DEVICE_CA_DIR`) issues
one client certificate per device. Keep its root key offline like the
server CA's, with its own passphrase. Whoever holds this key decides which
devices can exist — it is the basis of licensing — and a leaked server
certificate key can never be turned into a device identity.

```bash
./mes-ca.sh init-device
./mes-ca.sh issue-device backend   backend
./mes-ca.sh issue-device node-gate edge-node
./mes-ca.sh issue-device node-sim  simulator
./mes-ca.sh check ~/mes-device-ca/issued/node-gate/cert.pem
```

The first argument becomes the certificate CN (= the MQTT user name once
Mosquitto uses `use_identity_as_username`), the second the role (OU). One
certificate per device: never share one between two machines, or you cannot
tell them apart or revoke one of them. Mosquitto's `cafile` is the **device**
CA's `root.crt` (it verifies clients), while `certfile`/`keyfile` stay the
server certificate (clients verify the broker against the server CA).

Not covered yet: client certificates for terminals/browsers, and a CRL
(revocation is done with the Mosquitto ACL / user list for now).

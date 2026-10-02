# Licensing (design, Oct 2)

Status: format, vendor tool and verification module are done and tested
(`packages/backend/src/license.ts`, `ops/license/mes-license.mjs`). **Not yet
wired into the backend** — see "Integration steps".

## Goals and decisions

- Subscription: a monthly/yearly renewal. Only the vendor can add edge nodes
  and terminals; they must not be copyable.
- Unit of licensing: **number of edge nodes and number of terminals**
  (decided Oct 2). The identity of an edge node is its device-CA client
  certificate.
- Expiry: **grace period, then read-only** (decided Oct 2). Default 14 days
  of full function with warnings; after that, configuration changes and
  adding devices are refused. **Data collection never depends on the
  license** — a lapsed subscription must not lose production data.
- Verification: **the backend verifies, offline-capable** (decided Oct 2).
  A renewal is a new signed file; no internet is needed to keep running.

## Three separate keys

| Key | Held by | Purpose |
|---|---|---|
| Server CA | vendor admin machine, offline | TLS server certificates (Mosquitto, nginx, Postgres) |
| Device CA | vendor admin machine, offline | one client certificate per edge node / backend; decides which devices exist |
| License key (Ed25519) | vendor admin machine, offline, own passphrase | signs license files; its **public** key is shipped with the backend |

Separate keys so that leaking one never gives the power of another.

## File format (`mes-license-v1`)

```json
{ "format": "mes-license-v1", "payload": "<base64url JSON>", "signature": "<base64url>" }
```

`signature` = Ed25519 over `"mes-license-v1\n" + payload bytes` (the exact
bytes, so no canonical-JSON problem; the prefix separates this use of the
key from any other). Payload fields:

| Field | Meaning |
|---|---|
| `v` | 1 |
| `licenseId`, `customer` | identification |
| `serial` | increases with every issued license; the backend refuses an older serial than it has stored (rollback protection) |
| `issuedAt`, `validFrom`, `validUntil` | ISO timestamps; `validUntil` is the end of the paid period |
| `graceDays` | days after `validUntil` with full function (default 14) |
| `deviceCaSha256` | sha256 of the customer's device CA root certificate: the license only verifies on the installation whose devices that CA signed |
| `limits.edgeNodes`, `limits.terminals` | the paid counts |

## States

| State | When | Behaviour |
|---|---|---|
| valid | before `validUntil` | everything works; warn in the UI from ~14 days before the end |
| grace | up to `graceDays` after `validUntil` | everything works; prominent warning |
| expired | after the grace period | **read-only**: ingestion, dashboards, history keep working; no new devices, no configuration changes |
| invalid | bad signature, wrong device CA, older serial, not yet valid, malformed | same as expired; the reason is shown to admins |

Adding a device checks `mayAddDevice(status, kind, currentCount)`.

## Vendor workflow (laptop)

```bash
node ops/license/mes-license.mjs keygen          # once; encrypted key in ~/mes-license-key
node ops/license/mes-license.mjs issue --customer "Name" --edge-nodes 2 --terminals 10 \
     --device-ca ~/mes-device-ca/root.crt --days 365 --grace 14
node ops/license/mes-license.mjs verify license-1.json --device-ca ~/mes-device-ca/root.crt
```
Renewal = `issue` again (the serial increases) and install the new file.
Back up `~/mes-license-key/license.key` offline; the `serial` file is the
counter.

## Integration steps (not done yet)

1. Config: `LICENSE_FILE` (path) and `LICENSE_PUBLIC_KEY_FILE`; the device
   CA fingerprint comes from the device CA root certificate that is already
   deployed next to Mosquitto (`deviceCaFingerprint`).
2. Table `license_state(serial, installed_at, last_seen_at)`; `minSerial` is
   the stored serial. `now` for verification is `max(system clock, last_seen_at)`
   so setting the clock back does not extend a license.
3. Evaluate at startup and hourly; expose `GET /api/license` (state, days
   left, limits, usage) for an admin banner.
4. Enforce in the **edge-node claim** endpoint (count active nodes) and in
   every configuration-changing route (a Fastify hook using
   `mayChangeConfiguration`). Never in the MQTT ingestion path.
5. Install flow: an admin uploads the new file (UI or CLI), the backend
   verifies it and stores it; serial must be >= the stored one.
6. Optional later: the backend fetches the renewed file from a vendor
   endpoint once a day. It is the same signed file, so a faked endpoint
   cannot forge a license; offline operation is unaffected.

## Open: terminals

Edge nodes have a certificate identity; terminals (tablets/browsers) log in
with user accounts. To count and limit terminals a terminal needs a
registered identity: either a registered-device record with a device token,
or a client certificate from the device CA (the "CA on the tablets" item).
Until decided, `limits.terminals` is carried in the file but not enforced.

## Honest limits

- The backend's code is on the customer's node, so a determined customer
  could patch the check out. The real protections are: the signature (no
  forged files), the **vendor-held device CA** (no new devices without a
  vendor-issued certificate — this, not the file check, makes the system
  non-copyable in practice), rollback and clock-set-back protection, and the
  contract. The license is a deterrent and a clean commercial control, not
  DRM.
- Losing the license key: existing licenses keep working until they expire,
  but no new ones can be issued; a new key means shipping a new public key
  to every installation. Keep an offline backup.
- Leaked license key: anyone could issue licenses. Rotate: new key, new
  public key in a backend release, re-issue all licenses.

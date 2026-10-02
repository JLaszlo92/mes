# Licensing (design, Oct 2)

Status: format, vendor tool, verification module and the backend wiring are
done and tested (`license.ts`, `license-policy.ts`, `license-service.ts`,
`license-routes.ts`, `ops/license/mes-license.mjs`). The backend ships in
**audit mode** (`LICENSE_ENFORCE=false`): it computes and reports the state
but restricts nothing until enforcement is switched on — see "Operation".

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

## Operation (backend)

Environment (`/etc/mes/backend.env`; all optional):

| Variable | Default | Meaning |
|---|---|---|
| `LICENSE_ENFORCE` | `false` | `true` = refuse restricted requests; `false` = audit mode (log "would block", change nothing). A typo fails the start instead of silently disabling it. |
| `LICENSE_FILE` | `/etc/mes/license.json` | the signed license |
| `LICENSE_PUBLIC_KEY_FILE` | `/etc/mes/license.pub` | vendor public key (from `keygen`) |
| `LICENSE_DEVICE_CA_FILE` | `/etc/mosquitto/certs/device-ca.crt` | the device CA root; its sha256 must match the license |

- The backend verifies at startup and hourly; `POST /api/license/reload`
  (admin) does it immediately. A renewal is a file replacement, no restart.
- `GET /api/license` (any logged-in user): state, days left, limits, usage.
- A system alert `license_health` is raised 14 days before expiry, in the
  grace period, when expired and when invalid; it resolves itself. In audit
  mode with no license file there is no alert.
- Table `license_state` (migration 038): highest installed serial and the
  latest time seen. Verification uses `max(system clock, last_seen_at)`, so
  setting the clock back does not extend a license. Conversely a clock that
  once jumped far into the future keeps the license "expired" until it is
  renewed; to undo a mistaken jump:
  `UPDATE license_state SET last_seen_at = now();`.

**What is restricted** (only when enforcing, and only while the state is
`expired` or `invalid`; during `valid`/`grace` everything works):
POST/PUT/PATCH on `/api/machine-registry`, `/api/edge-nodes`,
`/api/edge-node-channels`, `/api/alert-rules`, `/api/sites`, `/api/areas`,
`/api/lines`. Creating an edge node (`POST /api/edge-nodes`) is additionally
refused at the `limits.edgeNodes` count even while valid.

**Never restricted:** reads, deletes, MQTT ingestion, the edge-node protocol
(`claim`, `heartbeat`), token regeneration (a leaked token must always be
rotatable), and every operator/production route. Nothing is restricted before
the first check finished, and a failed check keeps the previous state.

### Rollout

1. Deploy in audit mode (default). `GET /api/license` shows `state: invalid`,
   reason "no license file" — expected.
2. Vendor: `issue` a license, copy `license.pub` and `license.json` to
   `/etc/mes/` (`0600`), `POST /api/license/reload`; the state becomes `valid`.
3. Watch the log for `license audit mode: ... would be refused` while using
   the system normally; there should be none.
4. Set `LICENSE_ENFORCE=true` in `/etc/mes/backend.env`, restart.
   Rollback = set it back to `false`.

## Open: terminals

Edge nodes have a certificate identity; terminals (tablets/browsers) log in
with user accounts. To count and limit terminals a terminal needs a
registered identity: either a registered-device record with a device token,
or a client certificate from the device CA (the "CA on the tablets" item).
Until decided, `limits.terminals` is carried in the file, shown in
`GET /api/license` (`usage.terminals` is `null`) but not enforced. There is
also no user-management route in `auth-routes.ts` to hook it to yet.

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

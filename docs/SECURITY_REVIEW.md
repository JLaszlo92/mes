# Security Self-Review — IEC 62443 SL2 Baseline

**Date:** September 21, 2026 · **Revised:** October 2, 2026 (device certificates)
**Scope:** PRD Section 8 (Cybersecurity & OT Security), assessed against
the current Phase 1 implementation. This is a self-review, not a formal
audit — per PRD 8.1, formal third-party certification is deliberately
deferred until a real customer contractually requires it. The goal here
is honesty, not a passing grade: every gap below is real and should be
treated as a to-do, not glossed over.

**Legend:** ✅ Compliant · ⚠️ Partial · ❌ Gap · ➡️ Deferred by design (per PRD's own phasing)

**What changed in the September 29 revision:** API authentication is now
deny-by-default (previously several read endpoints were public), the
dashboard WebSocket requires a single-use ticket, the Postgres password
was rotated and moved out of the unit file, the hardcoded fallback
database credential was removed from the code, and audit coverage was
extended to scheduling and shift/calendar configuration. Three findings
were added in this pass: no login rate limiting, session token stored in
`localStorage`, and a permissive CORS policy.

**What changed in the October 1 revision:** every network path is now
encrypted — MQTT (TLS listener, plain 1883 removed), the API,
dashboard and WebSocket (nginx reverse proxy on 443; the backend itself
listens on loopback only), the edge node's HTTP calls, and the Postgres
connection (`hostssl` + `sslmode=verify-full`). Certificates come from an
internal CA whose root key is kept offline. Fastify `trustProxy` and CORS
pinning were done in the same pass, and the frontend is a static build
served by nginx instead of the Vite dev server.

**What changed in the October 2 revision:** MQTT now authenticates every
device. Mosquitto has a single listener (8884) that requires a client
certificate issued by a separate, offline *device CA*, takes the
certificate CN as the user name and enforces per-topic ACLs; anonymous
access (and the old 8883 listener) is gone. Backend, edge node and the
admin laptop each have their own certificate (8.3).

## 8.1 — Standards Alignment

➡️ **Formal SL2 certification** — deferred by design. This document is
the informal self-review PRD 8.1 describes as the MVP-appropriate step;
a real audit is explicitly a Later-phase item once a customer requires
it contractually.

## 8.2 — Network Architecture & Segmentation

✅ **Outbound-only edge connections** — the edge agent always initiates
the connection to the MQTT broker (`mqtts://192.168.60.141:8884`); nothing
reaches inbound into node-gate from node-dc. This matches the "no inbound
firewall rule needed" requirement in shape.

✅ **Encrypted transport** *(was ❌, fixed Oct 1)* — every path uses TLS,
with certificates from an internal CA (`ops/ca/mes-ca.sh`; ECDSA P-256,
encrypted root key kept offline on an admin laptop, 1-year server
certificates):

| Path | Now |
|---|---|
| Edge node / edge agents / backend → Mosquitto | `mqtts://…:8884`, mutual TLS (TLS 1.2, client certificate required, see 8.3); the plain `1883` and the earlier anonymous `8883` listeners are gone. Clients verify the broker against the server CA (`MQTT_CA_FILE`) and connect by the IP in the certificate's SAN |
| Browsers and terminals → backend | nginx reverse proxy: HTTPS on 443 (TLS 1.2/1.3); port 80 only redirects. API, `/ws` (`wss://`) and the static frontend all go through it |
| Edge node → backend (claim, heartbeat) | `https://…` through the proxy; the CA is trusted via `NODE_EXTRA_CA_CERTS` |
| Proxy → backend | plain HTTP on `127.0.0.1:3001` only — the backend binds to loopback (`HOST=127.0.0.1`) and cannot be reached from the network |
| Backend → Postgres | TLS 1.3 with `sslmode=verify-full`; `pg_hba.conf` uses `hostssl`, so a TCP connection without TLS is refused. Postgres itself listens on loopback only |

Verified on the pilot: a client without the CA cannot connect to the
broker, and one without a device certificate is dropped by it; the backend with a wrong CA fails with "unable to verify the first
certificate" (so `verify-full` really verifies); a TCP connection to
Postgres with `sslmode=disable` is rejected ("no encryption"); the backend
(3001) and Postgres (5432) listen on loopback only, and plain MQTT (1883),
the old anonymous MQTT port (8883) and the Vite port (5173) are closed.

⚠️ **Still open around TLS** — the CA must be installed on every
browser and terminal tablet (done on the admin laptop; the tablets are
still to do). `mes.pilot.internal` is a placeholder name with no DNS
record; clients use the IP, which is in the certificates' SAN.
Certificates expire after one year (October 2027) and renewal is manual
(`mes-ca.sh check` exits 2 below 30 days); an expired broker certificate
stops every edge agent.

## 8.3 — Identity, Authentication & Access Control

✅ **Human user authentication** — RBAC (5 roles), session-based auth,
MFA required for admin/manager, no hardcoded application-level
credentials (the `create-admin` script requires explicit input).

✅ **Deny-by-default API authentication** *(new, Sep 29)* — a global
auth guard (`packages/backend/src/auth-guard.ts`) requires a valid
session on every route not on an explicit, commented `PUBLIC_ROUTES`
allowlist (health, login, MFA login, logout, edge-node claim/heartbeat,
and `/ws`, which authenticates itself — see below). Before this, route
protection was opt-in and a number of read endpoints (machine registry,
work orders, assignments, alerts, fault codes, terminal UIs, off-shift
segments, current-shift) were readable without logging in. Role checks
(`requireRole`) remain route-level on top. Rolled out through a
report-only phase (`AUTH_MODE=report`) and verified in enforce mode.

✅ **Dashboard WebSocket authentication** *(new, Sep 29)* — `/ws`
requires a 256-bit, single-use ticket valid for 30 s, obtained from
`POST /api/auth/ws-ticket` with a valid session, so the session token
never goes into a URL. Connections are capped at 10 minutes and then
re-authenticated, which bounds how long an expired or revoked session
keeps receiving live events. The WebSocket also no longer connects while
signed out.

✅ **Login rate limiting and lockout** *(was ❌, fixed Sep 30)* —
`auth-throttle.ts`, counters in the `auth_throttle` table (survive a
restart). 5 failures per account+IP pair in 15 min → 15 min lock; 20 per
account from any IP in 60 min; 30 per IP across accounts in 15 min
(password spraying); 5 wrong MFA codes per user in 15 min. The lock is
keyed on the account+IP *pair* first, so an attacker can't lock a
legitimate operator out of their own terminal; the account- and IP-wide
limits cover distributed attacks. While locked the password isn't even
checked (429 + `Retry-After`). MFA has its own counter because a correct
password resets the login counter — without it the 6-digit code could be
brute-forced with a known password. Unknown accounts get the same
response *and the same response time* (a dummy hash is verified), so
login doesn't reveal which accounts exist; identifiers are normalized so
case variants can't bypass a lock. Lock events are audited
(`login_locked`, `mfa_locked`); blocked requests go to the journal only.
Verified on node-dc. **Behind the reverse proxy** *(Oct 1)*: limits key
on `request.ip`, so Fastify's `trustProxy` is set to the proxy address
(`TRUST_PROXY=127.0.0.1`); audit entries carry the real client IP
(verified), and the IP-wide limit does not treat everyone as one client.
Without `TRUST_PROXY` the setting is `false` — remember this if the
proxy's address ever changes.

✅ **Session tokens hashed at rest** *(fixed Sep 30)* — the `sessions`
table previously held raw bearer tokens (as its primary key), so read
access to the database or to a backup yielded live sessions, admin ones
included, bypassing MFA — made more pressing by backups now leaving the
host. Only the SHA-256 of each 256-bit token is stored now (migration
028; existing sessions hashed in place). Expired sessions are purged on
login. Remaining: `mfa_pending_logins` still stores raw pending tokens —
low risk, since a pending token is useless without the TOTP code and
lives only minutes.

⚠️ **Session token storage** *(new finding)* — the browser keeps the
session token in `localStorage`, readable by any script running on the
page. The practical risk is an XSS bug anywhere in the frontend turning
into session theft. No such bug is known, and React's default escaping
limits the surface, but an `HttpOnly`, `Secure`, `SameSite=Strict`
cookie would remove the exposure. That change requires CSRF handling; HTTPS, the
other prerequisite, has been in place since Oct 1.

✅ **CORS policy** *(was ⚠️, fixed Oct 1)* — the backend used to reflect
any requesting origin (`origin: true`). It now allows only the origins
listed in `CORS_ORIGINS` (comma-separated, in the backend's systemd
drop-in); with the variable unset, no cross-origin request is allowed at
all. Verified from the admin laptop. Since the frontend and the API share
one origin behind the proxy, normal use needs no CORS.

✅ **Per-device identity on MQTT** *(was ❌, fixed Oct 2)* — a second CA,
the *device CA* (`~/mes-device-ca` on the admin laptop, own passphrase,
offline), issues one client certificate per device
(`mes-ca.sh issue-device <name> <role>`; ECDSA P-256, 1 year). It is kept
separate from the server CA on purpose: a leaked server key can never be
turned into a device identity, and whoever holds the device CA key decides
which devices may exist — the basis for licensing (who may add nodes and
terminals). Mosquitto (`conf.d/tls.conf`, reference copy in
`ops/mosquitto/`) has one listener: port 8884, `cafile` = the device CA,
`require_certificate true`, `use_identity_as_username true`,
`allow_anonymous false`, `per_listener_settings true`, `acl_file`. Issued
so far: `backend`, `node-gate` (edge node), `admin-laptop` (read-only
tool) and `node-sim` (unused — the node-sim machine only runs simulated
PLCs, no MQTT client). ACLs (`/etc/mosquitto/acl.conf`): `backend` reads
`mes/machines/+/events` and writes `.../acks`; `node-gate` the reverse;
`admin-laptop` reads `mes/#` and `$SYS/#`. Tested on the pilot and on a
separate test broker: no certificate, or one from the server CA → refused;
a valid device certificate without an ACL entry connects but its
publishes are dropped and nothing is delivered to it (Mosquitto still
answers the subscribe with "granted").

⚠️ **Limits of the device identity** — the ACL works on topic *patterns*,
not per machine id, because the machines assigned to an edge node change
in the backend: a compromised edge node with its valid key could still
publish events for any machine id (see the next finding). Revocation is by
removing the device's entry from `acl.conf` and `systemctl reload
mosquitto`; the certificate itself stays valid until it expires (no CRL
yet — Mosquitto's `crlfile` is the next step if that is needed). The
private key is a file and can be copied; the edge node's session lease
detects two instances claiming the same node, binding the key to hardware
(TPM) is a later option. Terminals and browsers use user login over HTTPS,
not client certificates. Client IDs are still predictable
(`edge-agent-<machineId>`), but the identity that counts is the CN.

✅ **mTLS between edge and cloud** *(was ❌)* — MQTT is now mutual TLS; the
edge node's HTTP calls (claim, heartbeat) go over HTTPS with the per-node
token.

⚠️ **Events from unregistered machines are accepted** *(new finding, Oct 1)* —
the backend stores events for any machine id on the broker. An event stream
for an id that is not in `machines` made the hourly production rollup fail
on a foreign key for **every** machine (found when an edge node fell back
to its default simulated machine; dashboard counts stopped until the
orphan events were deleted). Since the broker now authenticates devices only a
holder of a valid device certificate could do this on purpose, but a
compromised edge node could (the ACL is per topic pattern, 8.3). Fix: drop events for unknown machines in the
subscriber and/or make the rollup ignore ids not in `machines`.

⚠️ **Edge node token handling** *(Oct 1)* — the edge node token used to
sit in the systemd unit file (world-readable) and was exposed in a chat;
it was regenerated and now lives in `/etc/mes/edge-node.env` (`0600`,
loaded with `EnvironmentFile=`). Rotation: regenerate in Admin → Edge
nodes, write the new value into that file, restart `mes-edge-node`; the
old instance's session lease may answer 409 for a minute or two. No token
expiry logic was found in the code — a token is valid until regenerated.
A node started without a token silently falls back to "legacy mode" with a
simulated default machine instead of failing — consider failing loudly.
Check that no other unit file or script on node-gate / node-sim contains
a token.

✅ **Database credentials** *(was ⚠️, fixed Sep 29)* — the `mes:mes`
password was rotated to a random 192-bit value, set with psql's
`\password` (hashed client-side, so it never reaches the server log in
plain text). It lives only in `/etc/mes/backend.env` (root-only, loaded
via `EnvironmentFile=`) and root's `~/.pgpass`, not in the systemd unit
and not in git. The backend's hardcoded fallback connection string
(`mes_dev_password`) was removed from `config.ts`: `DATABASE_URL` is now
mandatory and the process refuses to start without it, without echoing
the value. Postgres `pg_hba.conf` enforces `scram-sha-256` on TCP
connections, so the password is actually checked. The connection is
encrypted and the server is verified (`sslmode=verify-full`, 8.2).

## 8.4 — Data Protection

✅ **Encryption in transit** *(was ❌, fixed Oct 1)* — see 8.2: MQTT, API,
WebSocket, edge-node HTTP and Postgres are all encrypted.

❌ **Encryption at rest** — the Postgres database uses a standard,
unencrypted installation. The edge agent's local offline buffer
(`/tmp/mes-edge-agent-buffer.ndjson`) is a plain-text NDJSON file on
node-gate's disk. Both should be encrypted at rest per PRD 8.4,
particularly the buffer file, which PRD explicitly calls out as more
exposed since it sits on shop-floor hardware.

✅ **Backups** *(was ❌, fixed Sep 30)* — daily `pg_dump` (custom format)
via `mes-backup.timer`, verified with `pg_restore --list` before upload,
kept locally (last 3) and in S3 (`eu-central-1`, private, versioned,
SSE-S3): 14 daily, 8 weekly, 13 monthly, retention enforced by bucket
lifecycle rules. The node-dc IAM user can write and read but **not
delete** (verified: `DeleteObject` → AccessDenied), so a compromised
node-dc cannot destroy its own backups; versioning plus a 30-day
noncurrent-version window covers overwrites. A full restore drill
(`mes-restore-test.sh`: download from S3 → restore into a scratch DB with
TimescaleDB pre/post-restore → table and row-count comparison) passed on
the first real backup (1.4 GB database, 128 MB dump). Scripts and setup:
`ops/backup/`. Failures and missed runs raise a MES alert (see 8.8). Backups contain everything in the
database (MFA secrets, session rows), so the bucket's access policy is
part of the security boundary.

➡️ **Tenant isolation** — not yet applicable; this pilot is single-tenant
by design (Emlid's own line). Relevant once Phase 2's multi-site/
multi-tenant work begins.

## 8.5 — Secure Software Development & Supply Chain

❌ **Dependency/container scanning in CI** — there is no CI pipeline at
all; every deploy is a manual `git pull` + `pnpm run build` +
`systemctl restart` over SSH. `pnpm audit` has not been run against the
current dependency tree.

⚠️ **Code review with a security mindset** — every change in this
project has gone through a review-and-discuss cycle, but there is no
second human reviewer independent of the person writing the code — a
single-person team's inherent limitation, not something to solve
artificially before it's warranted.

❌ **SBOM** — not currently maintained for the edge agent, despite PRD
suggesting this is reasonable "from early on." Worth generating at least
once (`pnpm ls --json` or a proper SBOM tool) as a near-term to-do rather
than a Later-phase item.

➡️ **Third-party penetration testing, public vulnerability-disclosure
process** — correctly deferred per PRD 8.5 itself, appropriate once the
product has paying enterprise customers.

## 8.6 — Patch & Update Management

✅ **Staged edge updates** — every edge-agent deployment is a named,
immutable git tag, deployed with a single deliberate command, never
automatic.

✅ **Reversible edge updates** — `scripts/deploy-edge-agent.sh --rollback`
reverts to the previous tagged release with one command.

➡️ **Signed edge updates** — deliberately deferred; see
`docs/EDGE_AGENT_RELEASES.md` for the reasoning (cryptographic signing is
disproportionate infrastructure for a one-node internal pilot, and the
tagging discipline already in place is the foundation such a scheme would
build on later).

⚠️ **Cloud-side deployment** — the backend/frontend deploy the same
manual way the edge agent used to (`git pull` + build + restart), with a
brief interruption during restart rather than a true rolling/zero-
downtime deployment. Since Oct 1 the frontend is a static production
build served by nginx from `/var/www/mes` (the Vite dev server unit is
disabled), but updating it is still a manual build-and-copy. Acceptable for a single-node pilot; worth revisiting
before a real production SLA is promised to an external customer.

## 8.7 — Legacy & Unpatchable Equipment

✅ **Read-only machine access** — every signal source (GPIO, S7, OPC-UA,
Modbus) only ever reads counters/status; none writes or sends control
commands to a machine. This is a meaningful, structural compliance point,
not just a coincidence of how the code happened to be written.

⚠️ **Defensive protocol parsing** — PRD 8.7 specifically flags industrial
protocol parsers as a historically common vulnerability source. Our
parsers (S7, OPC-UA, Modbus) handle *connection failures* robustly as of
the chaos-testing work, but have not been specifically tested against
*malformed or malicious* data from a misbehaving or compromised PLC (e.g.
an out-of-range register value, a truncated response). Worth a dedicated
pass, not folded into this review.

➡️ **Asset-risk view** (flagging outdated/unauthenticated connected
devices) — correctly a Later-phase item per PRD 8.7 itself.

## 8.8 — Monitoring, Logging & Incident Response

✅ **Audit logging of application-level security events** — logins
(success/failure), MFA failures, logouts, and configuration changes are
captured in the queryable `audit_log` table, visible to admins. As of
Sep 29 coverage also includes work-order scheduling
(`work_order_rescheduled` / `work_order_unscheduled` with before/after
segments, `work_order_assignment_updated`), shift patterns, shifts,
calendars and machine scheduling assignments — previously unaudited.
New routes are expected to audit every mutation; the remaining
known exceptions are adding parts and labor to maintenance work orders.
*Fixed Sep 30:* most entries had no attributable actor in the admin view
(`actor_email` was only filled when the caller passed it). The email is
now snapshotted on every write and old rows were backfilled — which also
keeps entries attributable after a user is deleted (`actor_id` is
`ON DELETE SET NULL`).

⚠️ **Access-denied events** — requests rejected by the auth guard (401)
and rejected WebSocket connections (`dashboard websocket rejected`) are
logged in the backend's systemd journal with IP, but not in `audit_log`.
Adequate for investigation by someone with server access; not visible
to an admin from the dashboard.

❌ **Edge-agent connect/disconnect events are not in the audit log** —
they exist in each service's own systemd journal (`journalctl`), but they
are not written to the queryable `audit_log` table an admin would
actually look at from the dashboard. A machine going offline is currently
only visible as a machine_status event and a raised alert, not as a
distinct, attributable audit entry.

⚠️ **Documented incident-response process** *(was ❌, draft Sep 30)* —
`docs/INCIDENT_RESPONSE.md`: what counts as an incident, SEV1–3 with
response times, roles, a first-hour checklist, playbooks tied to this
deployment (evidence preservation commands, containment per situation —
sessions, Postgres/AWS/edge secrets, MQTT, node isolation — and restore
from the S3 backups), customer communication and a post-incident review.
Still open: names, contacts, customer notification timelines, and the
GDPR / NIS2 scope confirmed by legal (placeholders in the document); a
first tabletop exercise.

✅ **Backup failure alerting** *(fixed Sep 30)* — dead man's switch:
every backup run records its result in `job_status`; the backend raises a
System alert if the last run failed or no backup succeeded in 26 h
(catching a timer that never ran, not just a failing one), and resolves
it after the next success. Verified end to end with a simulated S3
failure. Remaining: if node-dc itself is down nothing can alert — an
external heartbeat would be needed for that.

➡️ **SIEM export** — correctly a Later-phase item per PRD 8.8 itself.

## Priority summary — what to actually do next

Ordered by how much real risk each closes relative to the effort:

1. **Complete the incident-response document** — fill in the contacts and
   have legal confirm the notification duties (the draft exists).
2. **TLS on every path — done (Oct 1)**: MQTT, API/WebSocket via the
   reverse proxy, edge-node HTTP and Postgres, with CORS pinning and
   `trustProxy` in the same pass.
3. **Per-device client certificates for MQTT — done (Oct 2)**: device CA,
   mutual TLS on 8884, `allow_anonymous false`, per-topic ACLs. Remaining
   from it: drop events for unregistered machine ids in the backend, a
   certificate renewal reminder (device certificates also expire in
   October 2027), optionally a CRL.
4. **Generate an SBOM and run a dependency audit** (`pnpm audit`). Low
   effort, meaningful for any procurement conversation.
5. Now that TLS is in place: consider moving the session token from `localStorage` to an
   `HttpOnly` cookie (with CSRF protection).
6. **Calendar reminder for certificate renewal** — the server
   certificates expire in October 2027 (`mes-ca.sh check` exits 2 within
   30 days); also install the CA on the terminal tablets.
7. Everything marked ➡️ above stays deferred, matching PRD's own guidance
   — revisit only when a specific customer's requirement makes it
   concrete, not speculatively.

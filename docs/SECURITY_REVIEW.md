# Security Self-Review — IEC 62443 SL2 Baseline

**Date:** September 21, 2026 · **Revised:** September 29, 2026
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

## 8.1 — Standards Alignment

➡️ **Formal SL2 certification** — deferred by design. This document is
the informal self-review PRD 8.1 describes as the MVP-appropriate step;
a real audit is explicitly a Later-phase item once a customer requires
it contractually.

## 8.2 — Network Architecture & Segmentation

✅ **Outbound-only edge connections** — the edge agent always initiates
the connection to the MQTT broker (`mqtt://192.168.60.141:1883`); nothing
reaches inbound into node-gate from node-dc. This matches the "no inbound
firewall rule needed" requirement in shape.

❌ **Encrypted transport** — the connection above is plain `mqtt://`, not
`mqtts://`. The backend's HTTP API is plain HTTP, not HTTPS. Postgres
connections are unencrypted. **This is the single largest gap in this
review** — PRD 8.4 requires TLS 1.2+ on every one of these paths, and
none currently have it. Fixing this means: enabling TLS on Mosquitto
(a certificate + config change, not a code change), terminating the
backend behind TLS (or a reverse proxy that does), and enabling
`sslmode=require` (at minimum) on the Postgres connection string.
The authentication work below makes this more pressing, not less: session
tokens and WebSocket tickets currently cross the network in clear text.

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

❌ **No login rate limiting or lockout** *(new finding)* — `POST
/api/auth/login` and `POST /api/auth/mfa/login` accept unlimited
attempts. Failures are audited (`login_failed`, `mfa_failed`) but not
throttled. MFA protects admin/manager accounts; operator, supervisor and
maintenance accounts are password-only and therefore brute-forceable
from anywhere that can reach the API. Fix: per-IP and per-account
throttling (e.g. `@fastify/rate-limit` on the auth routes) plus a
temporary lockout after repeated failures.

⚠️ **Session token storage** *(new finding)* — the browser keeps the
session token in `localStorage`, readable by any script running on the
page. The practical risk is an XSS bug anywhere in the frontend turning
into session theft. No such bug is known, and React's default escaping
limits the surface, but an `HttpOnly`, `Secure`, `SameSite=Strict`
cookie would remove the exposure. That change requires CSRF handling and
HTTPS first, so it naturally follows the TLS work.

⚠️ **CORS policy** *(new finding)* — the backend registers
`@fastify/cors` with `origin: true`, which reflects any requesting
origin. Because authentication is a bearer token rather than a cookie,
this does not currently enable cross-site request forgery, but it is
broader than needed and would become a real issue if auth moved to
cookies. Should be pinned to the frontend's own origin(s).

❌ **Per-device identity for edge agents** — every edge agent connects
with a predictable client ID pattern (`edge-agent-<machineId>`) and no
per-device certificate or credential on the MQTT side. The Mosquitto
broker has no authentication configured at all — any client on the
network segment could currently connect and publish or subscribe. There
is no way to revoke one compromised edge device at the broker without
affecting others. (The HTTP-side edge-node registry does use per-node
tokens with hashed storage and session leases; the gap is the MQTT
path.) This is a real gap relative to PRD 8.3's PKI-based device
identity expectation.

❌ **mTLS or equivalent between edge and cloud, terminal and edge** — not
implemented; follows directly from the TLS gap above.

✅ **Database credentials** *(was ⚠️, fixed Sep 29)* — the `mes:mes`
password was rotated to a random 192-bit value, set with psql's
`\password` (hashed client-side, so it never reaches the server log in
plain text). It lives only in `/etc/mes/backend.env` (root-only, loaded
via `EnvironmentFile=`) and root's `~/.pgpass`, not in the systemd unit
and not in git. The backend's hardcoded fallback connection string
(`mes_dev_password`) was removed from `config.ts`: `DATABASE_URL` is now
mandatory and the process refuses to start without it, without echoing
the value. Postgres `pg_hba.conf` enforces `scram-sha-256` on TCP
connections, so the password is actually checked. Remaining gap: the
connection itself is unencrypted (8.2).

## 8.4 — Data Protection

❌ **Encryption in transit** — see 8.2; the same gap applies here.

❌ **Encryption at rest** — the Postgres database uses a standard,
unencrypted installation. The edge agent's local offline buffer
(`/tmp/mes-edge-agent-buffer.ndjson`) is a plain-text NDJSON file on
node-gate's disk. Both should be encrypted at rest per PRD 8.4,
particularly the buffer file, which PRD explicitly calls out as more
exposed since it sits on shop-floor hardware.

❌ **Backups** — no automated backup process has been set up for the
Postgres database at all. This is not just a security gap but a basic
operational risk — a single disk failure on node-dc would lose all
production, quality, and traceability data collected so far. This should
be treated as urgent, independent of the rest of this review.

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
downtime deployment. The frontend still runs as the Vite dev server
(`pnpm dev`) under systemd rather than a static production build behind
a web server. Acceptable for a single-node pilot; worth revisiting
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

❌ **Documented incident-response process** — does not exist. PRD 8.8
says this should exist before the first paying customer, even if simple.
This is a genuine, easy-to-fix gap: a short document (who gets notified,
how, what the customer is told, expected timelines) would close it.

➡️ **SIEM export** — correctly a Later-phase item per PRD 8.8 itself.

## Priority summary — what to actually do next

Ordered by how much real risk each closes relative to the effort:

1. **Set up automated Postgres backups.** Not technically in Section 8,
   but the single highest-consequence gap found in this review — an
   unrecoverable single point of failure for every module built so far.
2. **Add login rate limiting and lockout.** Small change, closes the
   brute-force path to every non-MFA account.
3. **Write the incident-response document.** A few hours of writing, and
   PRD explicitly wants it before any paying customer.
4. **Enable TLS on Mosquitto, the backend API, and Postgres.** The
   largest cluster of related gaps (8.2, 8.3, 8.4) — genuinely blocking
   for any customer whose IT/OT team reviews this seriously, and now also
   what protects the session tokens and WebSocket tickets in transit.
   Pin CORS to the frontend origin in the same pass.
5. **Add MQTT broker authentication + per-device credentials.** Closes
   the biggest identity gap; a reasonable next step after TLS is in place
   (credentials should travel encrypted).
6. **Generate an SBOM and run a dependency audit** (`pnpm audit`). Low
   effort, meaningful for any procurement conversation.
7. After TLS: consider moving the session token from `localStorage` to an
   `HttpOnly` cookie (with CSRF protection).
8. Everything marked ➡️ above stays deferred, matching PRD's own guidance
   — revisit only when a specific customer's requirement makes it
   concrete, not speculatively.

# Security Self-Review — IEC 62443 SL2 Baseline

**Date:** September 21, 2026
**Scope:** PRD Section 8 (Cybersecurity & OT Security), assessed against
the current Phase 1 implementation. This is a self-review, not a formal
audit — per PRD 8.1, formal third-party certification is deliberately
deferred until a real customer contractually requires it. The goal here
is honesty, not a passing grade: every gap below is real and should be
treated as a to-do, not glossed over.

**Legend:** ✅ Compliant · ⚠️ Partial · ❌ Gap · ➡️ Deferred by design (per PRD's own phasing)

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

## 8.3 — Identity, Authentication & Access Control

✅ **Human user authentication** — RBAC (5 roles), session-based auth,
MFA required for admin/manager, no hardcoded application-level
credentials (the `create-admin` script requires explicit input).

❌ **Per-device identity for edge agents** — every edge agent connects
with a predictable client ID pattern (`edge-agent-<machineId>`) and no
per-device certificate or credential. The Mosquitto broker has no
authentication configured at all — any client on the network segment
could currently connect and publish or subscribe. There is no way to
revoke one compromised edge device without affecting others. This is a
real gap relative to PRD 8.3's PKI-based device identity expectation.

❌ **mTLS or equivalent between edge and cloud, terminal and edge** — not
implemented; follows directly from the TLS gap above.

⚠️ **Database credentials** — `mes:mes` is used as the Postgres
username/password throughout this pilot. This is a reasonable, known
default for an internal, single-customer pilot on a private network
segment, but it is a hardcoded, weak credential and must be rotated
before this pattern is reused for any external-facing or multi-customer
deployment.

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

✅ **Staged edge updates** — done this session (M8 slice 2): every edge-
agent deployment is a named, immutable git tag, deployed with a single
deliberate command, never automatic.

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
downtime deployment. Acceptable for a single-node pilot; worth revisiting
before a real production SLA is promised to an external customer.

## 8.7 — Legacy & Unpatchable Equipment

✅ **Read-only machine access** — every signal source (GPIO, S7, OPC-UA,
Modbus) only ever reads counters/status; none writes or sends control
commands to a machine. This is a meaningful, structural compliance point,
not just a coincidence of how the code happened to be written.

⚠️ **Defensive protocol parsing** — PRD 8.7 specifically flags industrial
protocol parsers as a historically common vulnerability source. Our
parsers (S7, OPC-UA, Modbus) handle *connection failures* robustly as of
this session's chaos-testing work, but have not been specifically tested
against *malformed or malicious* data from a misbehaving or compromised
PLC (e.g. an out-of-range register value, a truncated response). Worth a
dedicated pass, not folded into this review.

➡️ **Asset-risk view** (flagging outdated/unauthenticated connected
devices) — correctly a Later-phase item per PRD 8.7 itself.

## 8.8 — Monitoring, Logging & Incident Response

✅ **Audit logging of application-level security events** — logins
(success/failure), logouts, and configuration changes (machines, work
orders, alert rules, terminal UIs, fault codes, maintenance schedules)
are all captured in the queryable `audit_log` table, visible to admins.

❌ **Edge-agent connect/disconnect events are not in the audit log** —
they exist in each service's own systemd journal (`journalctl`), which
this session leaned on heavily for the chaos-testing work, but they are
not written to the queryable `audit_log` table an admin would actually
look at from the dashboard. A machine going offline is currently only
visible as a machine_status event and a raised alert, not as a distinct,
attributable audit entry.

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
2. **Write the incident-response document.** A few hours of writing, and
   PRD explicitly wants it before any paying customer.
3. **Enable TLS on Mosquitto, the backend API, and Postgres.** The
   largest cluster of related gaps (8.2, 8.3, 8.4) — genuinely blocking
   for any customer whose IT/OT team reviews this seriously.
4. **Add MQTT broker authentication + per-device credentials.** Closes
   the biggest identity gap; a reasonable next step after TLS is in place
   (credentials should travel encrypted).
5. **Generate an SBOM and run a dependency audit** (`pnpm audit`). Low
   effort, meaningful for any procurement conversation.
6. Everything marked ➡️ above stays deferred, matching PRD's own guidance
   — revisit only when a specific customer's requirement makes it
   concrete, not speculatively.
# Development Status

**Last updated:** September 16, 2026

## Where things stand

Phase 1 milestones **M0 through M4 are complete**, plus a substantial slice of
work-order/scheduling/terminal functionality that goes beyond what ROADMAP.md
originally scoped into M2. The project also moved from zip-based delivery to
a real GitHub remote (`https://github.com/JLaszlo92/mes.git`), with all three
Proxmox nodes (node-dc `.141`, node-gate `.142`, node-sim `.143`) now tracking
the same `main` branch.

The codebase is a TypeScript monorepo (Node edge agent, Fastify backend,
React frontend, a shared event-schema package) — see the repo's own
`README.md` for how to run it. SQL migrations live in
`packages/backend/sql/`, numbered `001` through `011`, each run idempotently
at backend startup by `migrate.ts` (which now runs *every* `.sql` file in the
folder in filename order, not just one hardcoded file).

## M0 — Walking skeleton: done (unchanged from prior status)

Simulated machine signal → edge agent → MQTT → backend → Postgres → live
dashboard, survives a broker outage with zero event loss. See the repo's
`README.md` and earlier status notes for the full write-up; nothing about
this milestone changed in this update.

## M1 — Core data pipeline: done, all four signal sources complete

`SignalSource` now has real implementations for all four connectivity modes
the PRD calls for, each running as an independent, `systemd`-managed
process, each verified end-to-end against its own simulator:

- **GPIO** (`GpioSignalSource`) — physical discrete I/O, bench-tested on the
  3-node Proxmox rig (see `docs/pi-test-rig.md`).
- **S7** (`S7SignalSource`) — polls a Siemens S7 PLC (or `plc-simulator/`)
  over the network, no wiring (`docs/pi-test-rig-s7-mode.md`).
- **OPC-UA** (`OpcUaSignalSource`) — pure TypeScript, no Python bridge,
  because `node-opcua` is a mature client *and* server library. Simulator:
  `opcua-simulator/opcua_simulator.js`. Documented in `docs/opcua-mode.md`,
  including the `alternateHostname` gotcha (the server advertises its own
  hostname by default; a client connecting by IP needs the server told to
  accept that IP too, or it fails with "Cannot find suitable endpoints").
- **Modbus TCP** (`ModbusSignalSource`) — also pure TypeScript
  (`modbus-serial`), same poll-and-diff shape as S7/OPC-UA. Simulator:
  `modbus-simulator/modbus_simulator.js`. **Not yet documented** — there is
  no `docs/modbus-mode.md` analogous to the OPC-UA one; worth writing before
  this mode is handed to someone unfamiliar with it.

**Known gap surfaced during M4 alert testing:** unlike GPIO's deliberate
pull-down fail-safe wiring (a broken wire reads as "down", not a false
"running"), the S7 bridge does **not** emit a "down" `machine_status` event
when it loses its connection to the PLC — it just stops sending anything,
and the backend's in-memory state store freezes on the last known status.
This meant a `machine_down` alert rule against the S7 rig never fired even
after stopping the PLC simulator for several minutes. Not fixed yet; a
reasonable fix would be either a bridge-side timeout that emits an explicit
"down" event, or a backend-side staleness check (if a machine hasn't sent
*any* event in N minutes, treat it as down/offline regardless of its last
reported status). Worth revisiting during M8 (resilience hardening) if not
sooner.

Systemd units in place: `mes-plc-simulator`, `mes-opcua-simulator`,
`mes-modbus-simulator` (node-sim); `mes-edge-agent` (S7),
`mes-edge-agent-opcua`, `mes-edge-agent-modbus` (node-gate) — multiple
edge-agent instances run concurrently on node-gate, each with its own
`MACHINE_ID` and `SIGNAL_SOURCE`.

## M2 — Production & Status Counting + OEE: done

- `machines` master data table (`003_machines.sql`): id, name, asset type,
  location, active flag, and now also `ideal_cycle_time_seconds`
  (`009_machine_ideal_cycle_time.sql`) for the OEE Performance component.
- `shift_definitions` + `resolve_shift()` (`002_shifts.sql`), correctly
  handling midnight-spanning night shifts.
- `/api/shifts/summary` now returns the full classical OEE breakdown per
  shift/machine: `availability`, `performance`, `quality`, and `oee`
  (Availability × Performance × Quality). `performance`/`quality`/`oee` are
  `null` (not a fake 100%) when there isn't enough data — no ideal cycle
  time set, or no parts counted yet.
- **Known simplification:** Performance is computed only from the machine's
  own `ideal_cycle_time_seconds`, never from a work order's
  `expectedCycleTimeSeconds` even when a `work_order_assignments` row
  overlaps the shift window. This was deliberately deferred (see below) —
  it's a small, well-understood enhancement whenever it's wanted.
- `ShiftSummaryPanel.tsx` and `MachineRegistryPanel.tsx` (frontend) both
  updated accordingly.

## M3 — Users, roles & auth: done, including MFA

- RBAC (`004_users.sql`): five roles (operator/supervisor/maintenance/
  manager/admin), enforced via `requireRole()` preHandlers.
- Session-based auth (not JWT) — server-side `sessions` table, individually
  revocable.
- Audit logging (`005_audit_log.sql`): logins (success/failure), logouts,
  and configuration changes (machine registry, work orders, alert rules,
  terminal UIs) all recorded with actor, IP, and timestamp.
- **TOTP-based MFA** (`010_mfa.sql`, `mfa-repository.ts`), using `otplib@^12`
  (pin this major version — `otplib@13` shipped a completely different,
  non-`authenticator`-based API that breaks this code) and `qrcode`.
  Enrollment flow: first login for an admin/manager without MFA set up
  succeeds but flags `mfaSetupRequired: true`; the frontend then forces a
  QR-code enrollment screen (`MfaSetup.tsx`) before showing anything else.
  Once enabled, login becomes two-step: password → short-lived pending
  token → 6-digit code → real session (`mfa_pending_logins` table, 5-minute
  TTL, atomically consumed via `DELETE ... RETURNING`).
- Frontend: `auth-context.tsx` and `LoginForm.tsx` both handle the two-step
  flow; `App.tsx` and `TerminalPage.tsx` both gate on `!auth` first.

## M4 — Alerts & notifications: done (MVP scope)

- `alert_rules` (config) and `alerts` (raised instances) tables
  (`011_alerts.sql`) — same rule/instance split as `shift_definitions` vs.
  actual shift data.
- Two rule types implemented: `machine_down` (minutes a machine has been
  continuously `down`) and `scrap_rate` (% scrap over a trailing 30-minute
  window, only evaluated once at least 5 parts have been counted, to avoid
  a single early scrap producing a false 100% reading).
- `alert-evaluator.ts` runs on a fixed interval (`EVAL_INTERVAL_MS`,
  currently `30_000` in production; was temporarily dropped to `1_000`
  during testing and correctly restored) inside the backend process
  (started from `index.ts` alongside `startMqttSubscriber`, not from
  `server.ts`). Alerts auto-resolve when the triggering condition clears.
- In-app delivery only (no email/SMS/Slack — explicitly a Later-phase PRD
  item). `AlertsPanel.tsx` polls `/api/alerts` every 15s; rule management
  (create/enable/disable/delete) is admin/manager-only, visible alerts are
  shown to everyone who opens the panel.
- **Postgres gotcha hit during build:** `COALESCE($n, ...)` against a
  `text[]` column needs an explicit `$n::text[]` cast — an untyped
  parameter defaults to `text` and Postgres refuses to assign it to an
  array column (`column "notify_roles" is of type text[] but expression is
  of type text`).

## Extra, ahead-of-schedule work: work orders, scheduling, machine terminal UI

Not itemized as its own ROADMAP milestone, but built as a natural extension
once M2's dashboard and M3's auth were in place. This gives M7
(maintenance, which will want its own work-order-like concept) a head
start.

- **`work_orders`** (`006_work_orders.sql`): order number, part name,
  quantity, expected cycle time, due date, status
  (planned/released/in_progress/completed/cancelled).
- **`work_order_assignments`** (`007_work_order_assignments.sql`) — the
  "finomtervező" (fine scheduler): assigns a work order to a machine for a
  planned time window. Real FKs to both `work_orders` and `machines`
  (unlike `events.machine_id`, which is deliberately loose). No overlap
  detection — PRD explicitly excludes full APS/finite-scheduling
  optimization from every phase; this is intentionally manual.
- **`terminal_uis` + `terminal_ui_machines`** (`008_terminal_uis.sql`) — a
  "terminal UI" is a named kiosk that can show one or more machines
  (many-to-many). Admin-managed via `TerminalUisPanel.tsx`.
- **`TerminalPage.tsx`** — a second, separate frontend view reachable at
  `/terminal/<terminal-ui-id>` (no router library added; `main.tsx` just
  pattern-matches `window.location.pathname`). Requires login (reuses the
  same `AuthProvider`/`LoginForm`); an operator sees only the work orders
  assigned to their terminal's machine(s) and can mark one "in progress"
  (`PUT /api/work-orders/:id`, now permitted for the `operator` role too,
  not just admin/manager — starting a job is explicitly an operator task
  per PRD 5.1).
- **Known gap, deliberately deferred:** `production_count` events still
  carry no `workOrderId` — there is no automatic link between what a
  machine actually produces and which work order was active when it did.
  Work order status changes are entirely operator-driven (clicking
  "Elkezdés"/"Start"), not derived from event counts. Fixing this properly
  means extending the shared `MachineEvent` schema
  (`packages/shared`) and touching the edge agent, the backend ingestion
  path, and the in-memory state store — a genuinely invasive change,
  correctly recognized as its own future step rather than something to
  bolt on casually.

## Git / infrastructure notes worth remembering

- **Each node's `~/mes` was bootstrapped into git independently**, not
  cloned fresh: `git init` → `git branch -M main` → `git remote add origin
  <url>` → `git fetch origin` → `git reset origin/main` (mixed reset —
  updates git's bookkeeping only, never touches files on disk). This
  surfaces every difference between that node's working copy and GitHub as
  a normal `git status` diff, without silently overwriting anything.
- **Always `git add` specific paths, never `-A` or `.`**, when working this
  way — a node's working copy legitimately lacks files another node owns
  (e.g. node-sim has no reason to have `packages/backend` "correct"), and
  those show up as spurious `deleted:` entries that must never be staged.
- **Stray files created on the wrong node** happened twice (an
  `opcua-simulator/` copy and a `ModbusSignalSource.ts` copy both
  accidentally created on the wrong machine) — caught via `git status`
  showing something unexpected as untracked/modified where it shouldn't
  have existed at all. Fixed by deleting the stray copy or `git checkout --
  <file>` to discard an accidental local edit before merging.
- **GitHub Personal Access Tokens were pasted into chat in full at least
  twice** — both were revoked and replaced immediately. Going forward:
  prefer the interactive `git push` credential prompt (paste directly into
  the terminal's hidden password field) over embedding a token in a
  command line or, worse, pasting it into any chat log.
- **`dist/` vs `src/`**: the backend runs compiled JS
  (`ExecStart=/usr/bin/node dist/index.js`), never `src/` directly. Every
  edit needs `pnpm run build` **and then** `systemctl restart mes-backend`
  — forgetting the restart is a recurring mistake (a route that "doesn't
  exist" after editing `server.ts` is almost always this). When a rebuild
  doesn't seem to take effect, `grep` the compiled `dist/*.js` for the new
  code directly rather than trusting that the build succeeded silently; a
  stale `.tsbuildinfo` incremental-build cache has caused this at least
  once, fixed by `rm -rf dist *.tsbuildinfo && pnpm run build`.
- **`DATABASE_URL` only exists inside the systemd unit's environment** —
  running a one-off script (e.g. `dist/scripts/create-admin.js`) from an
  interactive shell needs it exported manually first (`export
  DATABASE_URL="postgres://mes:mes@localhost:5432/mes"`, copied from
  `systemctl cat mes-backend`).
- **React hook-order rule**: a conditional early return (`if (!auth) return
  <LoginForm />`) must come *after* every hook call in the component
  (`useState`, `useEffect`, etc.), never between them — placing it too
  early causes React to see a different number of hooks between renders
  and silently blank the page with no console error explaining why.
- **Terminal multi-line paste is unreliable in this environment** — heredoc
  blocks (`cat > file << 'EOF' ... EOF`) have repeatedly lost line breaks
  or merged lines on paste. A single-line `printf '...\n...\n' > file`
  command (with explicit `\n` escapes) has proven far more reliable for
  creating systemd unit files and similar multi-line content directly from
  a terminal.
- **npm package major-version surprises**: both `node-opcua`'s TypeScript
  types and `otplib`'s v13 API changed enough to break code written against
  older assumptions. When a fresh `pnpm add <package>` behaves unexpectedly,
  checking `Object.keys(require('<package>'))` directly is a fast way to
  see what's actually exported before guessing further.

## What's next

Per ROADMAP.md's dependency order, **M5 (Quality management + lot
traceability)** is next — the PRD groups these two together because they
share data-model concepts (a non-conformance needs to trace back to the
affected lot/units).

Remaining Phase 1 milestones and rough estimates (unchanged from the
original ROADMAP.md sizing, since none of them have been started):

| Milestone | Remaining estimate |
|---|---|
| M5 — Quality + lot traceability | ~5 weeks |
| M6 — Digital work instructions (static) | ~2 weeks |
| M7 — Maintenance management (core) | ~4 weeks (likely faster in practice — the work-order/terminal infrastructure built ahead of schedule should transfer directly) |
| M8 — Security & resilience hardening | ~3 weeks (should explicitly revisit the S7 "no down status on disconnect" gap noted above) |
| M9 — Pilot deployment & iteration | ~3 weeks |

**Total remaining: ~17 engineering weeks**, or roughly **22–25.5 calendar
weeks (~5–6 months)** applying the ROADMAP's own 1.3–1.5× solo/two-person
multiplier.

# Development Status

**Last updated:** September 24, 2026

## Where things stand

**Phase 1 (M0–M8) is fully complete, and the entire "node-dc polishing"
list is now also complete.** Next up is **M9** (live pilot on a real
Emlid production machine) — picking the actual target machine is still an
open decision, not something buildable from a sandbox session.

The repo (`JLaszlo92/mes`, private GitHub) is a TypeScript monorepo run
across three Proxmox LXC nodes: node-dc (`.141`, backend + frontend +
Postgres + Mosquitto), node-gate (`.142`, edge agent), node-sim (`.143`,
protocol simulators). All three are in sync on `main` as of this update.

## Milestone recap (M0–M8)

See the repo's git history / earlier versions of this doc for full detail
on M0–M8 (walking skeleton, protocol adapters, RBAC+MFA, quality/
traceability, work instructions, maintenance, chaos-tested edge-agent
resilience, staged edge releases, IEC 62443 SL2 self-review). The honest
security headline from that self-review still stands and is worth acting
on before any external pilot: no TLS anywhere yet, no automated Postgres
backups, no incident-response document.

## The "node-dc polishing" list — now fully complete

This spanned two long sessions. All eight items are done:

1. **Audit log filtering + pagination** — 24h/7d/30d/all presets, "load
   more". Surfaced and fixed a pre-existing bug where `/api/shifts/summary`
   had silently gone missing from `server.ts`.

2. **Custom machine statuses + OEE classification**
   (`machine_status_definitions`) — arbitrary status names (global or
   per-machine), each tagged `counts_as_down` or `excluded`.
   `changeover`→`excluded` is a genuine OEE-accuracy fix over the old
   hardcoded behavior.

3. **Configurable status source per machine**:
   - **Signal-presence mode** (`SignalPresenceWatchdog.ts`) — infers
     running/down from whether production counts are arriving, computed
     **at the edge** (not the backend) so a network blip can't produce a
     false "down".
   - **Production gate** (`ProductionGate.ts`) — toggle for whether
     counts are accepted while status-bit reports "down".
   - Both are protocol-agnostic wrappers around any `SignalSource`.
   - The secondary-status-bit refinement (a different status name from a
     second bit/register when the primary running-bit is off) is the one
     item from the original brief that's still open — it's genuinely
     protocol-specific (Modbus register vs. OPC-UA node ID vs. S7 DB
     offset vs. GPIO pin all differ) and would need building four times.
     Not blocking anything; revisit if a real customer's hardware needs it.

4. **Edge-node registry** — the biggest architectural change of the two
   sessions:
   - `edge_nodes` + `edge_node_channels`: one edge-node (physical device)
     can carry any number of channels (machines), each with its own
     protocol/connection config/status-mode settings.
   - Per-node secret token (SHA-256 hash stored, shown once), used by the
     edge-agent to "claim" its configuration from the backend.
   - **Session-lease duplicate protection**: a second claim with the same
     token is rejected outright if the previous session heartbeated
     within 90 seconds — guarantees at most one live process per node.
   - Edge-agent has two paths: `EDGE_NODE_TOKEN` set → claims config +
     runs multiple channels over one MQTT connection; not set → original
     single-machine env-var behavior, unchanged (compatibility fallback).
   - **Proven live**: the three simulator rigs (S7, Modbus, OPC-UA), each
     previously its own systemd service, are now one registered edge-node
     (`mes-edge-node.service`) with three channels. The old three services
     are stopped+disabled (not deleted) on node-gate.

5. **Retroactive downtime-reason capture** — a background evaluator
   (`downtime-periods-evaluator.ts`) detects every completed "down" period
   from the events table and stores it (idempotently, via
   `md5(machine_id || started_at)` as the row ID — no pgcrypto extension
   needed). "Explaining" a period reuses the existing M5 fault-code
   `createFaultReport` call and links it back via `fault_report_id`. Shows
   up in a Quality-tab panel with one-tap fault-code buttons per period.

6. **Work-order production-quantity tracking** — turned out to need far
   less invasive plumbing than originally feared. Rather than tagging
   events with a `workOrderId` at write-time (which would have required
   the edge-agent to know about work orders — a layering violation), progress
   is computed **at read-time** by reusing the same audit-log-based
   "when did this work order start" lookup that M5's Lot generation
   already used (`computeWorkOrderProgress`, now shared by both). Delivers:
   - Live remaining-quantity countdown on the terminal (`X / Y db kész —
     Z hátra`).
   - Per-work-order `completion_mode` (`manual` | `auto`) and
     `count_overproduction` (bool) settings.
   - Auto-complete is **event-driven, not polled**: a good `production_count`
     event triggers an immediate check (`checkAndAutoCompleteWorkOrders`,
     called from `mqtt-subscriber.ts` right after the event is persisted)
     rather than waiting on a periodic sweep — this was a direct fix for a
     real bug caught in testing, where a 30-second polling interval let a
     3-piece auto-complete order overshoot to 12 before closing. A periodic
     evaluator (`work-order-auto-complete-evaluator.ts`, 60s) still runs as
     a safety net.
   - `count_overproduction = false` caps a work order's counted output at
     its target quantity (finds the timestamp of the Nth good event and
     stops counting there) — this same capped-window logic now also feeds
     Lot generation, so genealogy respects the same setting.

7. **Terminal refinements** — historical (completed/cancelled) work
   orders collapse behind a "Show history (N)" button, off by default.
   Current-shift good/scrap/OEE shown inline per machine, reusing
   `getShiftSummary` (new `getCurrentShiftSummaryForMachine` wrapper: query
   the last 24h of shifts, take the most recent one for that machine — no
   new SQL needed).

8. **Historical reporting** — `machine-history-repository.ts` gives
   hour/day/week/month-bucketed counts, status-seconds, OEE, and average
   cycle time for any machine and date range, rendered with `recharts`
   (bar chart for good/scrap, line charts for OEE/availability and cycle
   time). Bucket boundaries are generated in Node (not pure SQL
   `date_trunc`, since week/month buckets are variable-length) and every
   status interval is properly clipped across bucket boundaries via a
   join — long-running statuses don't get misattributed entirely to their
   start bucket. Work-order history lookup (the other half of the
   original ask) is already substantially covered by the existing Lots
   panel from M5, so wasn't rebuilt separately.

## Real bugs found and fixed this cycle (worth remembering)

- **`buildSignalSource`/`buildInnerSignalSource` naming-swap** — the two
  functions ended up with swapped names and one had a self-recursive
  dead-code call; the wrapping silently never happened, no error anywhere.
  Only debug print statements traced it.
- **Stale index in `019_edge_nodes.sql`** — that migration created an
  index on `edge_nodes.machine_id`; migration `020` then dropped that
  column (moving it to `edge_node_channels`), which **implicitly drops
  the index too** (standard Postgres behavior, no CASCADE needed). Because
  `migrate.ts` re-runs every `.sql` file on every startup, this was a
  ticking time bomb: it worked the one time 019+020 ran together in the
  same boot, then broke the *next* clean restart of `mes-backend` (which
  didn't happen until a day later) with a cryptic "column does not exist"
  error. Fixed by removing the stale `CREATE INDEX` line from 019.
- **SQL scoping bug in `machine-history-repository.ts`** — a `status_seconds`
  CTE tried to reference `clip_end`/`clip_start` from its *own* outer
  SELECT instead of the already-aggregated `seconds` column from the
  subquery. Straightforward once spotted, but a reminder that this kind
  of nested-CTE column-scope mistake compiles fine as SQL text and only
  fails at query-plan time.
- **30-second polling window let a 3-piece auto-complete work order
  overshoot to 12** — fixed by moving the check from a periodic evaluator
  to an event-driven hook in the MQTT ingestion path itself, which reacts
  within milliseconds of the event being durably persisted rather than
  waiting on the next poll tick. The periodic evaluator remains as a
  60-second safety net, not the primary mechanism.

## What's next

**M9**: pick the real target Emlid machine (open decision — needs an
actual line/machine and signal inventory, not something to resolve from a
sandbox), connect it via whichever protocol it exposes, onboard real
users, and run the live feedback/bug-fix loop the roadmap always intended
for this milestone.

**Before any pilot involving real production data**, independent of
milestone numbering, the security review's top three gaps are worth
closing: TLS everywhere (currently plaintext MQTT/HTTP/Postgres),
automated Postgres backups, and a written incident-response process.

**Smaller open items, no urgency**: the secondary-status-bit refinement
from item 3 above (protocol-specific, revisit if a real customer's
hardware needs it).

## Practical notes for whoever (or whatever session) picks this up

- All three nodes are pushed and pulled to the same commit as of this
  writing. `git config pull.rebase false` for divergent-branch merges and
  `unset GIT_ASKPASS VSCODE_GIT_ASKPASS_NODE VSCODE_GIT_ASKPASS_MAIN`
  before `git push` are both routine at this point, not surprising.
- **Backend work must be built and run on node-dc, not node-gate.**
  node-gate's local checkout is missing several backend-only files
  (`auth-plugin.ts`, `password.ts`, `sessions-repository.ts`,
  `scripts/create-admin.ts` — show up as "deleted" in `git status` there,
  harmless, never stage them) — this caused a real, avoidable confusion
  this session when a backend build was accidentally run there instead.
- `mes-edge-node.service` on node-gate is the single, token-based service
  now carrying all three simulator channels. The old
  `mes-edge-agent`/`mes-edge-agent-modbus`/`mes-edge-agent-opcua` units
  still exist on disk but are stopped+disabled — don't start them without
  first stopping `mes-edge-node`, or two processes will publish to the
  same machine IDs simultaneously.
- The edge-node's secret token lives in
  `/etc/systemd/system/mes-edge-node.service`'s `EDGE_NODE_TOKEN=` line on
  node-gate — "New token" in the admin panel if it's ever lost, then
  update the unit file.
- `rm -rf dist *.tsbuildinfo` before rebuilding is still the fix whenever
  behavior doesn't match code after a `pnpm run build` — this is a
  recurring `tsc` incremental-build-cache issue in this environment, not a
  one-off.
- Whenever `mes-backend` won't start after a fresh restart following
  schema changes, suspect a stale migration file before suspecting new
  code — `migrate.ts` re-runs every `.sql` file on every boot, so any
  migration that isn't perfectly idempotent against *later* migrations'
  changes (like the 019/020 index case above) can lie dormant until the
  next clean restart.

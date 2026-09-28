# Development Status

**Last updated:** September 28, 2026

## Where things stand

Phase 1 (M0–M8) and the full "node-dc polishing" list are complete. The
M-7 flexible shift/calendar feature is now **slice A + B done, C not
started** (see below). Today also included a full UX-feedback round and a
major, from-first-principles performance overhaul of the whole query
layer — the kind of work that would otherwise have hit hard during a real
100-machine pilot.

## Today's session — two parts

### Part 1: UX fixes from a fresh feedback list

1. Machine display names fixed on the Overview (see Part 2 — folded into
   the Overview redesign).
2. Tab sectioning — `CollapsibleSection.tsx` groups Production, Quality,
   Maintenance and Admin tab contents.
3–5. **Overview redesign** — replaced the old WebSocket-driven live card
   grid and the separate `ShiftSummaryPanel` with `MachineOverviewPanel.tsx`,
   showing correct names, current-shift-only stats, and all three OEE
   components (availability/performance/quality), not just the composite
   number.
6. Per-machine status timeline chart, added to `MachineHistoryPanel.tsx`.

Three real bugs found and fixed along the way:
- **`stateStore` never rehydrated from Postgres on restart** — every
  machine defaulted to a false "idle" until its next real status event.
  Fixed with `stateStore.rehydrateStatuses()` at startup.
- **Wrong-shift bug**: `getCurrentShiftSummaryForMachine` picked "the last
  row" from a list sorted `shiftDate, then shiftName alphabetically` —
  "afternoon" < "day" < "night" alphabetically has nothing to do with
  time-of-day order, so an already-ended shift could outrank the truly
  current one, making dashboard numbers look "frozen." Fixed by querying
  `resolve_shift(now())` directly.
- A stray duplicate `startAlertEvaluator()` call in `index.ts`.

### Part 2: Flexible shift patterns & calendars — Slice B done

**Slice A** (schema + admin UI: `shift_patterns`, `shift_pattern_shifts`,
`calendars`, `calendar_working_days`, per-machine assignment,
`auto_offshift_status` flag) was already done. **Slice B is now also
done**: `resolve_shift()` takes a `machine_id` parameter, reads that
machine's own pattern + calendar, and falls through to a synthetic
`'off_shift'` shift name (OEE category `excluded`) for any timestamp
outside all defined shifts or on a non-working day. Every SQL call site
updated to pass `machine_id`.

**Slice C (auto off-shift status evaluator) is still not built.**

### Part 3 (the big one): performance overhaul

Triggered by a simple question — "why is switching machines on Machine
History so slow, and will this scale to 100 machines?" — this turned into
a full, honest performance investigation. In order of discovery:

1. **The `events` table (1.7M+ rows) had zero indexes.** Every time-range
   query was a full sequential scan. Added
   `events_machine_type_timestamp_idx`, `events_type_timestamp_idx` (see
   `025_events_indexes.sql`).
2. **`resolve_shift()` as PL/pgSQL was un-inlineable** — Postgres cannot
   fold a PL/pgSQL function into a calling query's plan, so calling it via
   `LATERAL` once per row (tens of thousands of times for a busy machine)
   carried real per-call overhead. Rewritten as a plain SQL (`LANGUAGE
   sql`) function, which the planner *can* inline.
3. **`getCurrentShiftSummaryForMachine` was scanning ALL machines' full
   24-hour history** just to throw away every row except the one
   requested machine's. Added an optional `machineId` filter to
   `getShiftSummary` so single-machine callers push the filter into the
   query instead of filtering client-side afterward.
4. **The Postgres connection pool was capped at `max: 5`** — sized
   originally for a low-concurrency ingestion path, long before the
   dashboard existed. A busy dashboard (Overview polling every machine,
   Machine History, admin panels) routinely needed more than 5
   connections at once, so unrelated queries queued behind each other,
   showing up as wildly inconsistent response times (30ms next to 1.5s)
   for the *same* endpoint. Raised to `max: 20`.
5. **The Overview fired one HTTP request per machine** for current-shift
   data, every 10 seconds. Fine at 7 machines, would not have been fine at
   100. Replaced with `getCurrentShiftSummaryForAllMachines()` — one SQL
   query that resolves every active machine's current shift and its
   counts/durations in a single round trip, each machine bounded to its
   *own* (small) shift window rather than a wasteful shared 24-hour scan.
6. **`getMachineHistory`'s 7-day good/scrap count query was itself slow**
   even with proper indexes — because for the aggressively fast test
   simulators (~1 event/2s), 7 days is genuinely 150k+ raw rows per
   machine to filter and JSONB-unpack. This is where **TimescaleDB** came
   in, matching what `ROADMAP.md` had already flagged as the point to add
   it:
   - Installed via Debian's **own** `postgresql-17-timescaledb` package
     (not Timescale's packagecloud.io repo, which has a known GPG
     signature problem on Debian trixie as of this writing) —
     `apt-get install postgresql-17-timescaledb`, then
     `shared_preload_libraries = 'timescaledb'` added manually to
     `postgresql.conf` (the package doesn't ship `timescaledb-tune`),
     Postgres restarted, `CREATE EXTENSION timescaledb`.
   - Converted `events` to a hypertable (`create_hypertable('events',
     'timestamp', migrate_data => true)`). This required first dropping
     and recreating every unique constraint on the table (`events_pkey`,
     the `source_event_id` uniqueness) as composite constraints that
     include `timestamp` — Timescale requires the partitioning column in
     every unique index. **Important**: this was first done by hand via
     `psql`, which caused a real incident — `migrate.ts` re-runs every
     `.sql` file on every backend restart, and a leftover line in
     `025_events_indexes.sql` (a bare, no-longer-valid unique index on
     `source_event_id` alone) crash-looped the backend on the next clean
     restart. Fixed, and the by-hand changes were captured properly and
     idempotently in `027_events_hypertable.sql` so fresh installs and
     future restarts do the same thing automatically.
   - **The Debian package is the Apache-licensed (OSS) edition only** —
     continuous aggregates are a Timescale-license "Community" feature
     and are not available here
     (`ERROR: functionality not supported under the current "apache"
     license`). Rather than fight the packagecloud.io repo's GPG issue to
     get the Community edition, built the equivalent by hand:
     `production_counts_hourly` (a plain rollup table, hourly good/scrap
     count per machine) plus `production-rollup-evaluator.ts` (a
     background job, same pattern as every other evaluator in this
     codebase, recomputing just the last 3 hours every 5 minutes — cheap,
     and covers late-arriving/buffered events). `getMachineHistory`'s
     counts CTE now reads from this small rollup table instead of raw
     events. One-time backfill for existing history is in
     `026_production_counts_rollup.sql`.
7. **`getStatusTimeline` could return 10,000+ segments** for a machine
   with a high status-flap rate (`opcua-rig-01`'s simulator toggles
   roughly once a minute — 11,404 status changes in 7 days), producing
   >1MB JSON responses that were slow purely due to transfer size over
   the person's VPN connection, unrelated to any query cost. Capped: if
   raw segments exceed 300, the function bins them into 300 equal-width
   time slices, picks the dominant (longest-duration) status per slice,
   and merges adjacent same-status slices — bounded response size
   regardless of how "flappy" a machine's status is.

**End state, measured directly on the server (bypassing the person's slow
VPN)**: `current-shift` for one machine went from ~2000ms to ~40ms; a
7-day machine-history query went from ~10s to near-instant; switching
between machines on the Machine History panel, which previously caused
the whole dashboard to lag, is now snappy. A full backup
(`/root/mes_backup_YYYYMMDD_HHMMSS.dump`, `pg_dump -F c`, ~116MB) was
taken on node-dc before any of the Postgres-level surgery, as a safety
net — worth checking it's still there and still relevant before deleting.

## Honest scaling assessment (100 machines, 10 years of data)

Discussed directly with the person rather than just claimed:

- **Hypertable chunk exclusion + the new indexes + the bulk current-shift
  endpoint + the rollup table** genuinely scale by design — none of them
  degrade with total historical data volume, because none of them scan
  more than a bounded, recent window regardless of table size.
- **What's *not* yet handled**: there is no data-retention policy. Raw
  `production_count` events at real (not artificially fast simulator)
  cycle times, times 100 machines, times 10 years, is still a genuinely
  large table — chunk exclusion keeps queries fast, but storage keeps
  growing unbounded. The standard answer (keep raw events for some
  retention window — 90–365 days is typical — then drop old chunks once
  the rollups already capture what's needed) has **not been implemented**.
  Worth doing before a real decade-scale deployment, not urgent now.
- **No rollup yet for status/duration data** (only production counts were
  rolled up) — status events are far lower-volume than production counts
  so this hasn't been a bottleneck, but the same rollup pattern could be
  applied if it ever becomes one.
- Native Timescale compression (which would help the retention story
  further) is Community-licensed and not available with the currently
  installed edition — revisit if the packagecloud.io GPG issue gets
  resolved upstream, or if it's worth fighting now.

## Still on the list

- **M-7 Slice C**: background evaluator for `auto_offshift_status`
  machines (synthesize an `off_shift` machine_status event when a machine
  is outside its calendar/pattern's working window).
- **Item 8** from the UX list: drag-and-drop Gantt-style work-order
  scheduling UI, sequenced after M-7 is fully done since the calendar
  constrains where a bar can be dropped.
- A data-retention policy for raw events (see scaling assessment above).
- "Additional MES ideas" floated earlier (CSV/PDF export, an andon board,
  downtime Pareto analysis, multilingual work instructions) — not started.

## Practical notes for whoever (or whatever session) picks this up

- All three nodes are pushed and pulled to the same commit as of this
  writing.
- **Backend work must be built and run on node-dc, not node-gate** —
  node-gate's local checkout is missing several backend-only files
  (shows as "deleted" in `git status` there, harmless, never stage them).
- `rm -rf dist *.tsbuildinfo` before rebuilding remains the fix whenever
  behavior doesn't match code after `pnpm run build`.
- **Any manual `psql` schema change must be captured in a numbered
  migration file afterward**, even if it already works on the live
  database — `migrate.ts` re-runs every `.sql` file on every backend
  restart, so an unrecorded manual change becomes invisible tech debt
  that can crash-loop the very next clean restart (see the
  `events_source_event_id_idx` incident above). This bit the project once
  already with the 019/020 stale-index issue and again today — treat it
  as a standing rule, not a one-off lesson.
- When a dashboard feels slow, check in this order before writing new
  code: (1) is the underlying SQL query itself slow (`EXPLAIN ANALYZE`
  directly via `psql`, bypassing the app entirely), (2) is a shared
  resource contended (the Postgres connection pool size bit this project
  twice in one session), (3) is the *response payload* just large
  (`status-timeline`'s 1MB+ payload looked like a "slow query" until the
  DevTools Network tab's size column showed the real story). Fixing the
  wrong layer wastes time — measure server-side first (`time curl` on
  node-dc itself, not through the person's VPN) to separate "genuinely
  slow" from "slow network."
- TimescaleDB is installed and `events` is a hypertable — anyone adding a
  new table that needs the same time-partitioning treatment should follow
  the same pattern (composite unique constraints including the
  partitioning column *before* calling `create_hypertable`), and should
  remember continuous aggregates are unavailable on this edition (use a
  manual rollup table + evaluator instead, matching
  `production-rollup-evaluator.ts`).

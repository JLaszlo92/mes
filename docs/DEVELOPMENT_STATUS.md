# Development Status

**Last updated:** September 25, 2026

## Where things stand

Phase 1 (M0–M8) and the full "node-dc polishing" list are complete (see
git history for that recap). This session was a fresh round of UX
feedback and one large new feature (flexible shift patterns/calendars),
which is **partially built — read the warning below before touching
anything shift-related.**

## Today's session — UX fixes

1. **Overview redesign** (machine names, current-shift-only stats,
   persistence, three OEE components) — replaced the old WS-driven live
   card grid and the separate `ShiftSummaryPanel` with one new
   `MachineOverviewPanel.tsx`, backed by the existing
   `getCurrentShiftSummaryForMachine`.

   Found and fixed three real bugs along the way:
   - **`stateStore` never actually rehydrated from Postgres on restart**,
     despite its own code comment claiming it did — every machine showed
     a false "idle" default until its next real status event. Fixed with
     `stateStore.rehydrateStatuses()`, called once at backend startup
     before the MQTT subscriber starts.
   - **Wrong-shift bug in `getCurrentShiftSummaryForMachine`**: it picked
     "the last row" from an array sorted `shiftDate, then shiftName
     alphabetically" — but "afternoon" < "day" < "night" alphabetically
     has nothing to do with chronological order within a day, so a
     shift that had already ended could outrank the one actually
     in progress. Numbers looked "frozen" because the panel kept
     re-displaying an ended shift's static totals. Fixed by querying
     `resolve_shift(now())` directly instead of guessing from sort order.
   - A stray duplicate `startAlertEvaluator(app.log)` call in `index.ts`
     (harmless, but cleaned up).

2. **Tab sectioning** — `CollapsibleSection.tsx`, wraps Production,
   Quality, Maintenance and Admin tab contents into named, collapsible
   groups.

3. **Per-machine status timeline chart** — new
   `machine-status-timeline-repository.ts` /
   `/api/machines/:id/status-timeline`, rendered as a proportional
   colored strip in `MachineHistoryPanel.tsx`, alongside the existing
   good/scrap, OEE/availability, and cycle-time charts (all four now
   share the same machine/period selector).

## Flexible shift patterns & calendars (M-7) — Slice A done, B and C pending

**⚠️ Important: this feature is NOT live yet.** Slice A (schema + admin
UI) is built and working — you can create shift patterns, add shifts to
them, create calendars with per-day working/non-working toggles, and
assign both (plus an `auto_offshift_status` flag) to any machine, and it
all persists correctly. **But `resolve_shift()` — the SQL function every
shift-based query (`getShiftSummary`, `getCurrentShiftSummaryForMachine`,
and therefore the Overview, the terminal's current-shift display, and any
future shift-scoped report) actually calls — is still the old, single
global-pattern version.** Nothing you configure in the new admin panel
has any effect on real data yet. Slices B and C are the next session's
starting point:

- **Slice B** (not started): make `resolve_shift()` take a `machine_id`
  parameter, look up that machine's `shift_pattern_id` +
  `calendar_id`, and fall through to a synthetic `'off_shift'`
  shift_name for any timestamp outside all defined shifts for a working
  day, or on a non-working day per the calendar. Then update every SQL
  call site (`shift-summary-repository.ts`'s two `resolve_shift(...)`
  calls, at minimum — grep for `resolve_shift` to find them all) to pass
  `machine_id`.
- **Slice C** (not started): a background evaluator that, for machines
  with `auto_offshift_status = true`, checks whether the current moment
  falls outside their calendar/pattern's working window and — if so —
  synthesizes a `machine_status: off_shift` event, the same way
  `downtime-periods-evaluator.ts` and `work-order-auto-complete-evaluator.ts`
  already run periodic checks. `off_shift` should get a
  `machine_status_definitions` entry with `oee_category = 'excluded'`
  (a migration, not code) so it doesn't count against availability.
- Once B is done, **item 7.2 from the original ask (terminal counter
  resets on shift change) needs no extra code** — it's an automatic
  consequence of the current-shift query being correctly shift-scoped.

A default pattern (`default-pattern`, "Standard 3-shift", seeded from the
old global `shift_definitions` rows) and a default 24/7 calendar
(`default-247`) were created and assigned to every existing machine
during migration `023`, so nothing broke — every machine's *configured*
scheduling is correct even though the *query logic* doesn't read it yet.

## Still on the list (from the same session, not started)

- **Item 8**: drag-and-drop Gantt-style work-order scheduling UI
  (machines on the Y-axis, time on the X-axis, bar width = cycle time ×
  quantity, constrained to each machine's calendar). Explicitly
  sequenced *after* M-7 is fully done, since the calendar is what
  constrains where a bar can be dropped.
- A few "additional MES ideas" were floated (CSV/PDF export, an andon
  board, downtime Pareto analysis, multilingual work instructions) but
  none were picked up yet — worth raising again if the person doesn't
  bring them up first.

## Practical notes for whoever (or whatever session) picks this up

- All three nodes are pushed and pulled to the same commit as of this
  writing.
- **Backend work must be built and run on node-dc, not node-gate** —
  node-gate's local checkout is missing several backend-only files
  (shows as "deleted" in `git status` there, harmless, never stage them).
  This tripped up a build earlier in this project; worth double-checking
  which node a shell is on before running `pnpm run build` for the
  backend.
- `rm -rf dist *.tsbuildinfo` before rebuilding remains the fix whenever
  behavior doesn't match code after `pnpm run build`.
- React hook calls must be inside the function component body — a stray
  `useState` placed at module scope (outside the component function)
  throws "Invalid hook call" and blanks the whole page. Easy to
  introduce when pasting a multi-part diff into an existing file; worth
  a visual double-check of indentation/scope after any such edit.
- When a dashboard number looks "stuck", check whether the *query* is
  actually re-deriving from Postgres on each call (as it should) versus
  reading a stale in-memory cache or picking the wrong row from a
  differently-sorted list — both have now bitten this project once each
  (see the two bugs above) and are the first things to suspect over a
  new, more exotic theory.

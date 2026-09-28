# Development Status

**Last updated:** September 28, 2026

## Where things stand

Phase 1 (M0–M8), the full "node-dc polishing" list, and the entire
"8-item UX + architecture" list from this multi-day stretch are now
**complete**, including M-7 (flexible shift patterns/calendars, all three
slices) and item 8 (drag-and-drop Gantt scheduler). This was an
exceptionally long, deep session — UX fixes, a full performance overhaul
(TimescaleDB, indexing, rollups), the shift/calendar system, and a working
Gantt scheduler all landed. See earlier revisions of this doc (git
history) for the fuller blow-by-blow; this update focuses on what's new
since the last save point: the Gantt scheduler being finished properly.

## The Gantt scheduler (item 8) — now fully working

Built in slices, each tested before moving on:

- **Visual layer**: machines as horizontal rows, time flowing left→right,
  existing assignments rendered as positioned bars.
- **Calendar/shift-aware shading**: originally only shaded whole
  non-working *days* (calendar granularity). Extended to hour-level
  shading via a new `off-shift-segments-repository.ts` /
  `GET /api/machines/:id/off-shift-segments`, which builds the machine's
  actual working windows per day from `shift_pattern_shifts` +
  `calendar_working_days` and returns the gaps — so a two-shift machine
  (e.g., 06:00–14:00 and 14:00–22:00) now correctly shows the overnight
  22:00–06:00 gap shaded, not just full off-days.
- **Drag-and-drop creation**: drag an unscheduled work order from a side
  list onto a machine's row; duration is `expectedCycleTimeSeconds ×
  quantity`; a new `validate-window` endpoint (samples `resolve_shift()`
  hourly across the window) rejects drops that land outside working time.
- **Auto-splitting across working windows**: if a work order's required
  duration doesn't fit in one continuous working window, it's
  automatically broken into multiple assignments (same work order, same
  machine, several `plannedStart`/`plannedEnd` rows) — fills the current
  window, skips the off-shift gap, continues in the next one, repeating
  until fully scheduled. Computed client-side (`computeSegments`) using
  the same off-shift-segments endpoint over a wide lookahead window (30
  days past the required duration, as a safety margin).
- **Moving existing assignments**: drag a scheduled bar to a new
  time/machine; duration is preserved. Needed a new `PUT
  /api/work-order-assignments/:id` (repository + route didn't exist
  before — only list/create/delete).
- **Unscheduling**: drag a scheduled bar back onto the side pool to
  delete all of its assignment rows (handles multi-segment orders
  correctly — removes every segment for that work order, not just the
  one dragged).
- **Cross-browser drag**: the initial implementation used the native
  HTML5 Drag and Drop API, which is notoriously unreliable in Safari with
  plain `<div>` elements — dragging back to the side pool silently failed
  there. Replaced entirely with a custom `mousedown`/`mousemove`/`mouseup`
  implementation using `document.elementFromPoint()` to detect drop
  targets (`data-machine-row` / `data-pool` attributes) — works
  identically across Chrome, Firefox, and Safari since it doesn't depend
  on any browser's native DnD quirks. One follow-up fix: the drop-pool
  container needed an explicit `minHeight` — when it only contained a
  couple of small cards, its actual rendered area was too small to
  reliably catch drops that landed a few pixels outside the card
  elements themselves.

**Not built**: resizing an existing assignment bar to change its
duration directly (only move is supported; to change duration, unschedule
and re-drop). Low priority — flagged if it comes up again.

## Practical notes for whoever (or whatever session) picks this up

- All notes from the previous revision of this doc still apply (build on
  node-dc not node-gate, `rm -rf dist *.tsbuildinfo` for stale-build
  issues, capture any manual `psql` change in a numbered migration
  immediately, TimescaleDB is installed as the Apache/OSS edition only —
  no continuous aggregates, `production_counts_hourly` +
  `production-rollup-evaluator.ts` is the manual substitute).
- New lesson from today: **native HTML5 drag-and-drop is not safe to rely
  on for cross-browser custom UI** — it works in Chromium browsers but
  is genuinely unreliable in Safari for anything beyond simple
  same-container reordering. For any future drag-and-drop feature, prefer
  the custom mouse-event + `elementFromPoint` pattern established in
  `GanttSchedulePanel.tsx` from the start, rather than discovering the
  Safari gap after building the native version first.
- A flex item containing a horizontally-scrollable child needs an
  explicit `minWidth: 0` (or the scrollable child's container does) — the
  flex default `min-width: auto` otherwise lets the wide content stretch
  the whole layout instead of confining scroll to the intended box. Bit
  this project once with the Gantt's day-view scrolling.

## Still open (lower priority, not blocking)

- Resize (not just move) for Gantt assignment bars.
- A data-retention policy for raw events (flagged in the previous
  revision, still not implemented — not urgent given current data
  volumes, worth doing before a real decade-scale deployment).
- "Additional MES ideas" floated earlier in this stretch (CSV/PDF export,
  an andon board, downtime Pareto analysis, multilingual work
  instructions) — not started.

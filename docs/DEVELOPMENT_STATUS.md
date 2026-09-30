# Development Status

**Last updated:** September 30, 2026

## Where things stand

Phase 1 (M0–M8), the full "node-dc polishing" list, and the entire
"8-item UX + architecture" list are **complete**, including M-7 (flexible
shift patterns/calendars, all three slices) and item 8 (drag-and-drop
Gantt scheduler). See earlier revisions of this doc (git history) for the
fuller blow-by-blow of that stretch.

Since the last save point (September 28):

- **Gantt scheduler finished properly**: bar resizing, whole-order moves,
  and scheduling moved to the server as a single atomic operation (see
  below). The "resize" item from the previous "Still open" list is done.
- **Gantt time axis**: background time bands, hour labels, a "now" line,
  and a DST-correct time axis.
- **Auth hardening (deny-by-default), live in enforce mode**: a global
  auth guard replaces the per-route opt-in model that had left a number of
  GET endpoints publicly readable. All frontend API calls now go through a
  central `apiFetch` (`packages/frontend/src/api.ts`). Rolled out via a
  report-only phase, verified, switched to enforce on September 29.
- **`/ws` closed with single-use tickets**: the dashboard's live event
  stream, the last unauthenticated data path, now requires a short-lived
  ticket obtained with a valid session.
- **Audit coverage and input validation** for shift patterns, shifts,
  calendars and machine scheduling assignments (previously unaudited;
  bad input gave 500s).
- **Postgres credentials rotated**, moved out of the unit file into a
  root-only env file; the hardcoded fallback connection string was
  removed from `config.ts`. `docs/SECURITY_REVIEW.md` revised to match.

Since September 30 (morning):

- **Automated Postgres backups to S3** with a passing restore drill (see
  "Backups" below).
- **Session tokens stored as SHA-256 hashes** (migration 028), expired
  sessions cleaned up on login.
- **Audit log always records who did it** — the actor's email is
  snapshotted on write (migration 029 backfilled old rows).
- **Calendars / shift patterns**: rapid day toggles no longer lose
  updates, API errors are shown, and a calendar or pattern still assigned
  to a machine can no longer be deleted (migration 030).

## The Gantt scheduler (item 8)

The original build (September 28) delivered the visual layer, hour-level
off-shift shading via `GET /api/machines/:id/off-shift-segments`,
drag-and-drop creation, auto-splitting across working windows, moving,
unscheduling, and the Safari-safe custom mouse-event drag
(`document.elementFromPoint()`). Those notes still apply. What changed
since:

### Scheduling is now server-side and atomic

Previously the frontend computed segments (`computeSegments`) and POSTed
them one by one, and unscheduling DELETEd them one by one. A failure
halfway through (network blip, a validation error on the third segment)
left a half-scheduled work order behind. Now:

- **`PUT /api/work-orders/:id/schedule`** sets a work order's entire
  schedule in one transaction. Body: `machineId`, `plannedStart`, and
  exactly one of:
  - `durationMs` — reserve this much *working time* from `plannedStart`,
    skipping off-shift gaps (drop from the pool, moving an order);
  - `plannedEnd` — reserve all working time inside the wall-clock span
    `[plannedStart, plannedEnd]` (resizing).
  The server computes the segments, deletes the old rows and inserts the
  new ones inside a transaction, with the `work_orders` row locked
  `FOR UPDATE` so two concurrent reschedules of the same order serialize.
  Audited as `work_order_rescheduled` with previous and new segments.
- **`DELETE /api/work-orders/:id/schedule`** removes all segments of an
  order atomically. Audited as `work_order_unscheduled`.
- Segmentation logic lives in `packages/backend/src/work-order-scheduling.ts`
  (pure functions `workingIntervals` / `chunksForDuration`, unit-tested,
  plus `planScheduleChunks` which loads off-shift segments). Its source of
  working time is the same off-shift query the Gantt shades from, so what
  the user sees and what the server accepts cannot diverge. Limits: 60
  days max per order, 30-day lookahead past the required duration.
- Transactional repository functions: `replaceScheduleForWorkOrder` and
  `clearScheduleForWorkOrder` in `work-order-assignments-repository.ts`.
- No schema change — duration is still the sum of an order's assignment
  rows.

**Business rules enforced by the new endpoints (409 on violation):**

- `completed` / `cancelled` orders cannot be rescheduled.
- An `in_progress` order can be moved in time but **not to another
  machine**: `computeWorkOrderProgress` counts production from the first
  assignment's machine, so a machine change would silently corrupt the
  running order's counts.
- Only `planned` / `released` orders can be unscheduled (dragged back to
  the pool).

The old per-segment endpoints (`POST`/`PUT`/`DELETE
/api/work-order-assignments[/:id]`) still exist as integration hooks but
**bypass these rules**; the frontend no longer uses them, nor
`validate-window`. The per-segment `PUT` was missing an audit event — now
logs `work_order_assignment_updated`.

### Frontend behaviour (`GanttSchedulePanel.tsx`)

- **Resize**: grab handles on the outer edges of an order only (left edge
  of the first segment, right edge of the last). The right edge changes
  the end, the left edge the start; the server re-splits across off-shift
  gaps. Middle segments have no handles — resizing them has no
  unambiguous meaning. 15-minute snap and minimum. The left handle is
  hidden on bars narrower than ~21px.
- **Live preview**: a dashed ghost bar while resizing; a tooltip shows
  start → end, working time vs. required time (cycle time × quantity)
  while resizing, and target machine + start while moving/dropping.
- **Under-planned warning**: an orange bottom stripe when an order's
  planned working time is shorter than cycle time × quantity. A warning,
  not a block — the planner may know better than the master data.
- **Moving** now moves the whole order by the drag delta. This fixed two
  old bugs: the bar used to jump so its *start* landed on the cursor, and
  a plain click (mousedown + mouseup, no movement) triggered a save.
- **Time bands**: alternating 2-hour background bands, hourly hairlines,
  stronger day boundaries, a second header row with `06:00`, `08:00`…
  labels (so 06/14/22 shift boundaries all land on a label), a red "now"
  line refreshed every minute, and auto-scroll to "now" on load. Rendered
  as one layer behind all rows with `pointer-events: none` so it doesn't
  interfere with `elementFromPoint` drop detection. Off-shift hatching is
  semi-transparent so the bands show through.
- **DST fix**: the axis used to assume 24-hour days (`i * 24 *
  PX_PER_HOUR`, `+ 86400000`), which would have shifted everything by an
  hour after the October 25 clock change. Days are now stepped by calendar
  (`setDate`) and positioned by real timestamps; a DST day renders 23 or
  25 hours wide.
- All reads now send the session token (required by the auth guard).

**Not built**: a per-segment manual override (e.g. deliberately leaving
a gap inside a working window). Not requested; the whole-order model
covers current usage.

## Auth guard (deny-by-default)

The previous model was opt-in per route (`requireRole` or an inline
`if (!request.user)`), and several GET endpoints had been left publicly
readable: machine registry, work orders, work order assignments,
off-shift segments, validate-window, alerts, fault codes, terminal UIs,
current-shift, shift summary, and the in-memory `/api/machines` state.
Any future route could be forgotten the same way.

`packages/backend/src/auth-guard.ts` inverts the default: a global
`preHandler` hook (registered right after `authPlugin`) requires a valid
session for every route that is not on an explicit `PUBLIC_ROUTES`
allowlist, matched on the Fastify route pattern. Role checks
(`requireRole`) remain route-level on top of this. The existing inline
`if (!request.user)` checks are now redundant but kept as
defence-in-depth.

Public by design: `GET /health`, `POST /api/auth/login`,
`POST /api/auth/mfa/login`, `POST /api/auth/logout`, and the edge-node
`claim` / `heartbeat` endpoints (they authenticate with their own token in
the body, not a user session). Unknown routes return 401 rather than 404
to unauthenticated callers.

**`AUTH_MODE`** (systemd `Environment=` on `mes-backend.service`):

- `enforce` (default when unset): unauthenticated requests get 401.
- `report`: requests pass through, but each one that enforce mode would
  reject is logged at warn level with `authGuard: "would_reject"`, method,
  route and IP. Meant only for the transition.
- Any other value fails startup, so a typo can't silently disable the
  guard.

**Rollout procedure** (report → fix frontend → enforce):

1. Deploy with `Environment=AUTH_MODE=report`.
2. Use every screen (dashboard, terminals, Gantt, admin pages), then list
   what still calls the API without a token:
   `journalctl -u mes-backend -o cat | grep would_reject | jq -r '.method + " " + .route' | sort | uniq -c`
3. Fix those frontend calls to send `Authorization: Bearer <token>`.
4. Remove the `AUTH_MODE` line (→ enforce), restart, confirm no 401s in
   normal use.

**Rollout state:** enforce live since September 29, 2026. The report
phase surfaced token-less calls from 23 frontend files; after the
`apiFetch` switch (below) the `would_reject` log stayed empty across a
full click-through, and the enforce switch was verified with `curl`
(`/health` → 200, `/api/work-orders` and `/api/machine-registry` → 401
without a token) and in the browser (every screen, including
`/terminal/:id`, shows only the login form when signed out).

### Frontend: `apiFetch` (`packages/frontend/src/api.ts`)

Every backend call goes through `apiFetch`, which has the same signature
as `fetch` and:

- attaches `Authorization: Bearer <token>` automatically, but only for
  requests to our own backend (`API_BASE`) — the token never leaks to
  another origin (e.g. an external PDF link in a work instruction);
- never overrides an explicitly passed `Authorization` header;
- on a 401 for a request it attached a token to, calls the handler the
  `AuthProvider` registered, which signs the user out (expired or revoked
  session → login form instead of a screen full of errors).

`auth-context.tsx` pushes the token into `apiFetch` **synchronously**
(`setApiToken` in the `useState` initializer and in `applyAuth`), not in a
`useEffect`: React runs child effects before parent effects, so a token
set in the provider's effect would miss the children's first loads.
Login, MFA login and logout deliberately keep plain `fetch`, so a logout
with an already-expired token can't trigger another sign-out. A corrupt
`localStorage` value no longer crashes the app.

The switch was done with a one-off, idempotent codemod,
`packages/frontend/scripts/use-api-fetch.mjs` (`fetch(` → `apiFetch(` plus
the import, across `src/`, skipping `api.ts` and `auth-context.tsx`). **Any
new frontend code should call `apiFetch`, never plain `fetch`, for backend
requests.** Quick check that nothing slipped through:
`grep -n "[^.a-zA-Z]fetch(" src/*.tsx src/*.ts | grep -v apiFetch` should
list only `api.ts` and `auth-context.tsx`.

### Frontend routing, for reference

The app is a single-page app on `/`, gated entirely by the
`AuthProvider`. The one exception is the operator terminal:
`main.tsx` matches `/terminal/:terminalUiId` and renders `TerminalPage`
(which has its own login gate) instead of `App`. Terminal UI ids:
`SELECT id, name FROM terminal_uis;`. Per-view URLs for the main app
(back button, deep links) would need a client-side router — not needed
for the pilot, since the terminal kiosk URL already works.

### WebSocket tickets (`/ws`)

Browsers can't send an `Authorization` header on a WebSocket, and the
session token must not go into a URL (proxy, server and browser logs).
So `GET /ws` stays on the guard's `PUBLIC_ROUTES` list, and the route
authenticates itself with a ticket (`packages/backend/src/ws-tickets.ts`):

- `POST /api/auth/ws-ticket` (session required) returns a 256-bit random
  ticket, valid for 30 s, **single-use**. It is not derived from the
  session token. Kept in memory (single-process monolith, no table);
  unredeemed tickets are swept periodically and lost on restart, which is
  harmless because the client asks for a new one on every connect.
- `/ws?ticket=…` redeems and deletes the ticket on connect. Missing,
  unknown, already-used or expired → closed with code **4401**, logged as
  `dashboard websocket rejected`. A ticket that ended up in a log is
  therefore already worthless.
- **Max connection lifetime 10 min**: the server closes with code
  **4000**, the client immediately reconnects with a fresh ticket (no
  visible "disconnected"). If the session expired or was revoked in the
  meantime, the ticket request gets 401, `apiFetch` signs the user out,
  and there is no reconnect. This bounds how long a dead session can keep
  receiving live events, without per-connection session polling.
- Close codes are defined in `ws-tickets.ts` and duplicated in `App.tsx`
  — keep them in sync.

Client side (`App.tsx`): the WebSocket now connects **only while signed
in** (before, it connected even behind the login screen), requests a
fresh ticket before every (re)connect, retries with backoff (2, 4, 8,
16, then 30 s instead of a fixed 2 s), and clears the live machine state
on sign-out. Verified: dashboard live with a `dashboard client
connected` log line carrying the `userId`; a ticket-less upgrade via
`curl` is rejected.

## Configuration and secrets (node-dc)

- `mes-backend.service` loads secrets from
  **`/etc/mes/backend.env`** (`EnvironmentFile=`, directory `0700`, file
  `0600`, root-only). It currently holds `DATABASE_URL`; `MQTT_URL` is
  still an `Environment=` line in the unit because it contains no secret.
  The Postgres password exists nowhere else except root's `~/.pgpass`, and
  never in git.
- `DATABASE_URL` is **mandatory** (`packages/backend/src/config.ts`):
  without it the backend exits at startup with `DATABASE_URL is not set`
  instead of silently trying a fallback. The error never echoes the URL.
  `PORT` is validated too.
- Ad-hoc database access: `psql -h localhost -U mes mes` — the password
  comes from `~/.pgpass`, so it never has to be typed or appear in a
  command line. (Older docs and chat history show
  `psql postgres://mes:mes@…`; that password no longer works.)
- Password rotation, if ever needed again: new value into
  `/etc/mes/backend.env` and `~/.pgpass`, then `su - postgres -c psql` →
  `\password mes` (hashed client-side) → `\q`, then
  `systemctl restart mes-backend`. Do not skip the `\password` step —
  the backend will fail with `password authentication failed`.

## Sessions, audit log and scheduling config — Sep 30 fixes

- **Session tokens are hashed at rest** (`sql/028_hash_session_tokens.sql`,
  `sessions-repository.ts`). The `sessions` table holds `token_hash` =
  SHA-256 of the 256-bit random token; the raw token exists only on the
  client. Previously it was the raw bearer token (and the primary key), so
  anyone with read access to the DB or a backup got live sessions,
  admins included, bypassing MFA. Plain SHA-256 is enough for random
  tokens (no slow password hash needed). The migration hashes existing
  rows in place and is guarded so re-running can't hash twice.
  `createSession` also deletes expired sessions, so the table can't grow
  past the live ones. `mfa_pending_logins` still stores raw tokens — low
  risk (useless without the TOTP code, minutes-long), left as a todo.
- **Audit actor email** (`audit-repository.ts`, `sql/029_…`): most routes
  pass only `actorId`, and `actor_email` was only filled when the caller
  passed it — so the Audit log panel showed "—" for nearly everything.
  `recordAuditEvent` now fills it in the same INSERT
  (`COALESCE($3, (SELECT email FROM users WHERE id = $2))`). It's a
  snapshot on purpose: `audit_log.actor_id` is `ON DELETE SET NULL`, so
  without the email a deleted user's entries would become anonymous.
  Migration 029 backfilled old rows with the user's *current* email.
- **Calendar day toggles** (`ShiftPatternsPanel.tsx`): each toggle built
  the new array from the last *loaded* state, so a second quick click
  overwrote the first (lost update — visible in the audit log as
  near-simultaneous `calendar_updated` rows). Now: built from the latest
  local state, applied optimistically, and the calendar's checkboxes are
  locked while its save is in flight. All mutations in the panel now
  check the response and show the API error.
- **In-use calendars / patterns can't be deleted**
  (`sql/030_restrict_machine_calendar_pattern_delete.sql`): the
  `machines.calendar_id` / `shift_pattern_id` FKs were `ON DELETE SET
  NULL`, so deleting an assigned calendar silently emptied the machine's
  assignment — and then **migration 023's re-run line** (`UPDATE machines
  SET calendar_id = 'default-247' WHERE calendar_id IS NULL`) quietly gave
  that machine a 24/7 calendar on the next restart (no more off-shift
  time; availability/OEE computed on a different basis). Now `ON DELETE
  RESTRICT`; the DELETE routes return 409 "still assigned to a machine".
  The migration finds the FK by column, not by name, and only swaps it if
  it isn't RESTRICT yet.

## Backups (node-dc → S3)

Daily at 02:30 UTC `mes-backup.timer` runs `mes-backup.sh`: `pg_dump`
(custom format) as postgres via peer auth, archive checked with
`pg_restore --list`, last 3 kept in `/var/backups/mes`, uploaded to
`s3://<bucket>/daily/` (Sundays also `weekly/`, the 1st also `monthly/`,
server-side copies). Retention (14 daily / 60-day weekly / 400-day
monthly, noncurrent versions 30 days) is enforced by **S3 lifecycle
rules**; the node-dc IAM user `mes-backup-node-dc` has only
`ListBucket` / `PutObject` / `GetObject` — no delete. Bucket in
`eu-central-1`, private, versioned, SSE-S3. Config in
`/etc/mes/backup.env` (no secrets); AWS key in `/root/.aws/` (profile
`mes-backup`). Everything, including the full AWS console walkthrough,
is in `ops/backup/README.md`.

- **Restore drill**: `mes-restore-test.sh` (latest from S3 → scratch DB
  `mes_restore_test` → table/row-count comparison → dropped). First run
  Sep 30: PASSED, 1.4 GB database → 128 MB dump. Run it monthly and after
  any Postgres/TimescaleDB upgrade; it needs free disk ≈ the database size.
- `pg_dump` warnings about circular foreign keys on `hypertable`,
  `chunk`, `continuous_agg` are TimescaleDB catalog noise, not errors.
- A real restore needs the **same TimescaleDB version** on the target and
  the `timescaledb_pre_restore()` / `post_restore()` wrapping (README).
- `S3_ENDPOINT_URL` switches the target to an on-prem S3-compatible store
  (e.g. MinIO) for customers whose data may not leave the site.
- **Alerting (dead man's switch)**: every run, success or failure, writes
  its result to `job_status` (`name = 'db_backup'`; failing step on
  failure, file/size/sha256 on success). `backup-health-evaluator.ts`
  checks it every 5 min and raises a **System** alert (Alerts tab, no
  machine) if the last run failed or there's been no successful backup
  for 26 h — which also catches a timer that never ran. One open alert
  per type (its message is updated, not duplicated); it resolves itself
  after the next successful backup. Verified on node-dc Sep 30 with a
  deliberately wrong bucket name. Limit: if node-dc is down, nothing on
  it can alert — that needs an external heartbeat (not set up).
- **System alerts** (`sql/031`): `alerts.machine_id` / `rule_id` are
  nullable for alerts not tied to a machine (CHECK: both or neither;
  unique partial index: one open system alert per type). The list shows
  them as machine "System"; `AlertsPanel` never offers "Create ticket"
  for them.
- **Fixed on the way**: `listAlerts` returned only alerts *raised* in the
  last 24 h, so an alert open for more than a day (e.g. a machine down
  since yesterday) silently vanished from the list. Now: all open alerts
  plus the last 24 h of resolved ones. `AlertsPanel`'s "Create ticket"
  now reports success/failure and doesn't create duplicates.

## Practical notes for whoever (or whatever session) picks this up

- All notes from previous revisions still apply: build on node-dc not
  node-gate; `rm -rf dist *.tsbuildinfo` for stale-build issues; capture
  any manual `psql` change in a numbered migration immediately;
  TimescaleDB is the Apache/OSS edition only — no continuous aggregates,
  `production_counts_hourly` + `production-rollup-evaluator.ts` is the
  manual substitute.
- **Native HTML5 drag-and-drop is not safe for cross-browser custom UI**
  (unreliable in Safari). Use the mouse-event + `elementFromPoint`
  pattern from `GanttSchedulePanel.tsx` from the start.
- A flex item containing a horizontally-scrollable child needs an
  explicit `minWidth: 0`, or the wide content stretches the whole layout.
- **Never build a time axis out of fixed 24-hour days.** Step days by
  calendar (`setDate(getDate() + n)`) and position by real timestamps, or
  DST changes shift everything by an hour. Hungary switches on the last
  Sunday of March and October.
- **`migrate.ts` re-runs every `.sql` file on every start — design
  migrations for that.** Data-changing migrations need a guard (028 checks
  the old column still exists; 029's `WHERE actor_email IS NULL` is
  naturally idempotent). And remember that old migrations keep running:
  023's `SET calendar_id = 'default-247' WHERE calendar_id IS NULL` is
  still live on every start, which is what turned a silent `SET NULL`
  into a silent 24/7 calendar.
- **Check the FK `ON DELETE` behaviour before relying on an FK error.**
  `SET NULL` / `CASCADE` never raise, so a route's "409 if in use" branch
  is dead code unless the FK is `RESTRICT` / `NO ACTION`.
- **UI state after a mutation: build the next value from local state, not
  from the last server response**, and lock the control while the save is
  in flight — otherwise quick consecutive edits overwrite each other.
- **Multi-step writes that must succeed together belong in one backend
  transaction**, not a client-side loop of REST calls. The Gantt's old
  segment-by-segment POST/DELETE is the cautionary example.
- **New routes are authenticated by default.** Adding one to
  `PUBLIC_ROUTES` in `auth-guard.ts` should come with a comment saying
  why.
- **Temporary service settings go in a systemd drop-in, not the unit
  file**: `systemctl edit mes-backend` (content goes *between* the two
  `###` marker lines, or it's discarded) or write
  `/etc/systemd/system/mes-backend.service.d/override.conf` directly and
  `daemon-reload`. Verify with `systemctl show mes-backend -p
  Environment`; remove with `systemctl revert mes-backend`.
- `systemctl restart` returns before the backend is listening. A `curl`
  or `journalctl` run immediately after can show `000` / no startup line —
  wait a second and re-check before debugging.
- **Never echo a secret into a terminal whose output gets pasted into a
  chat, ticket or doc.** If it happens, treat the value as exposed and
  rotate it — which is what happened with the first new Postgres
  password on Sep 29.
- Debian LXC nodes lack a generated UTF-8 locale (perl/psql warnings,
  and the likely cause of the old `watch` unicode error on node-gate):
  `apt install -y locales && sed -i 's/^# *en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen && locale-gen`.
- When pasting a multi-part patch into `server.ts`, each block goes
  inside its own route handler — a `recordAuditEvent` block pasted at the
  end of `buildServer()` fails the build with `Cannot find name
  'request'`.

## Still open (lower priority, not blocking)

- **External heartbeat** for node-dc itself (backup alerting can't fire
  if the host is down) — decide before the pilot whether it's needed.
- **Check the 58k `downtime_periods` rows** — very high for 7 machines;
  possibly status flapping (e.g. the signal-presence watchdog) creating a
  period per flap. Worth a look before the pilot's downtime Pareto relies
  on it.
- `mfa_pending_logins` stores raw pending tokens — hash like sessions
  (low risk, low effort).
- **Login rate limiting / lockout** — `POST /api/auth/login` and
  `/api/auth/mfa/login` accept unlimited attempts; non-MFA accounts are
  brute-forceable. See `docs/SECURITY_REVIEW.md` for the full, updated
  priority list (backups first).
- Several config mutations still write **no audit event**: shift pattern
  / shift / calendar create-update-delete and `PUT
  /api/machine-registry/:id/scheduling`. PRD 8.8 expects configuration
  changes to be audited.
- The old per-segment assignment endpoints bypass the scheduling business
  rules — either route them through the same checks or retire them once
  it's clear no integration needs them.
- A data-retention policy for raw events (flagged in earlier revisions,
  still not implemented — not urgent at current volumes, worth doing
  before the pilot).
- Cleanup: 25 frontend files each recompute `WS_URL` / `API_BASE`;
  `api.ts` now exports `API_BASE`, so these can become imports.
- "Additional MES ideas" floated earlier (CSV/PDF export, an andon board,
  downtime Pareto analysis, multilingual work instructions) — not started.

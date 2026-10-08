# Development Status

**Last updated:** October 7, 2026

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
- **Backup failure alerting** (dead man's switch → System alert).
- **Login rate limiting and lockout** (migration 032, `auth-throttle.ts`;
  login routes moved to `auth-routes.ts`).
- **Downtime periods**: evaluator rewritten (no split periods, incremental —
  136 s → 0.12 s per tick on 120k events), per-machine micro-stop
  threshold (the "to explain" list went from 58,947 to 617 rows), downtime
  summary, race-safe explain (migrations 033, 034), and a **downtime
  Pareto** by reason.
- **Three data-correctness bugs found and fixed** while preparing a
  raw-event retention policy — see "Time, rollups and retention prep".

Since October 2 (edge agent, October 5):

- **Edge agent v5**: parts produced while the agent is down or cannot reach
  the PLC are booked afterwards (catch-up, per-node limit
  `catchupMaxMinutes`, default 10); a clean `systemctl restart` no longer
  costs ~70 s because the agent releases its instance lease on SIGTERM.
  Backend: migration 039 (`edge_nodes.settings`), settings API, release
  endpoint. See "Edge agent v5 and v6" below.
- **Edge agent v6**: channels start without waiting for the MQTT broker
  (events go to the disk buffer), acks are re-subscribed on every connect.
- **Chaos tests (M8) slices 2-4** run on the pilot nodes: broker, backend and
  agent outages, `kill -9` with a non-empty buffer, start with the broker
  down. No loss and no duplicates in any of them (`docs/CHAOS_TEST_FINDINGS.md`).
  The edge buffer was moved from `/tmp` (tmpfs) to `/var/lib/mes-edge`.

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
`claim` / `heartbeat` / `release` endpoints (they authenticate with their own token in
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
  `0600`, root-only). It currently holds `DATABASE_URL` (ending in `?sslmode=verify-full`, see
  "TLS on every path"). Non-secret settings (`MQTT_URL`, `MQTT_CA_FILE`,
  `TRUST_PROXY`, `CORS_ORIGINS`, `HOST`, `NODE_EXTRA_CA_CERTS`) are
  `Environment=` lines in drop-ins under
  `/etc/systemd/system/mes-backend.service.d/`.
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

## TLS on every path and the internal CA — Oct 1

Since Oct 1 all network traffic is encrypted (assessment and verification
results: `docs/SECURITY_REVIEW.md` 8.2). Plain MQTT (1883) and the anonymous 8883 listener are gone (MQTT is mutual
TLS on 8884, see "Device certificates and MQTT access control" below), the
backend (3001) and Postgres (5432) listen on loopback only, and the Vite
dev server (5173) is disabled.

- **CA** (`ops/ca/mes-ca.sh`, README next to it): run on an admin machine,
  never on node-dc. `init` creates an encrypted root key (10 years,
  default dir `~/mes-ca`; keep it out of git and back it up offline —
  without it nothing can be renewed); `issue <name> <SAN,...>` makes a
  1-year server certificate (refuses to overwrite: move the old directory
  away to re-issue); `check <cert>` exits 2 if it expires within 30 days.
  Needs OpenSSL 3.x (macOS's LibreSSL does not work). Issued and deployed:
  `mosquitto`, `proxy` (nginx) and `postgres`. SANs: `DNS:mes.pilot.internal`
  (placeholder, no DNS record yet) and `IP:192.168.60.141`; the postgres
  cert also has `localhost` / `127.0.0.1`. **Renewal: reminders via
  `mes-ca.sh ics`, alert via the node-dc expiry monitor (Oct 2).** An expired broker certificate stops every
  edge agent. The public `ca.crt` is at `/etc/ssl/mes-ca.crt` on node-dc
  and node-gate.
- **Mosquitto** (node-dc): `/etc/mosquitto/conf.d/tls.conf` has a single
  listener, 8884 (`cafile` = device CA, `certfile`/`keyfile` = the server
  certificate in `/etc/mosquitto/certs/`, `tls_version tlsv1.2`,
  `require_certificate true`, `use_identity_as_username true`,
  `allow_anonymous false`, `acl_file`; `per_listener_settings true` on the
  first line). `conf.d/mes.conf` is only a comment now (old plain
  listener: `/root/mes.conf.bak`). `cert.pem` / `ca.crt` / `device-ca.crt`
  must be `0644`, `key.pem` `0640 root:mosquitto`, `acl.conf`
  `0640 root:mosquitto`, otherwise the broker fails with "Unable to load
  CA certificates ... Permission denied" (logged to
  `/var/log/mosquitto/mosquitto.log`, not the journal). Reference copies:
  `ops/mosquitto/`.
- **MQTT clients**: `MQTT_CA_FILE` (path to the CA PEM) is read by
  `mqtt-tls.ts` in both `backend` and `edge-agent`; unset = no change. The
  URL must use a name or IP that is in the certificate's SAN
  (`mqtts://192.168.60.141:8884`, not `127.0.0.1`). The edge-agent tag
  `edge-agent-v2` added the TLS support, `edge-agent-v3` the client
  certificate (`MQTT_CLIENT_CERT` / `MQTT_CLIENT_KEY`, both or neither).
- **Reverse proxy** (`ops/proxy/mes-nginx.conf`, installed as
  `/etc/nginx/sites-available/mes`, default site removed): 80 → 301 to
  https; 443 with the `proxy` certificate (`/etc/nginx/certs/{cert,key}.pem`),
  TLS 1.2/1.3, `server_tokens off`, 25 MB body limit. `/api/` and `/health`
  → `127.0.0.1:3001`; `/ws` with WebSocket upgrade and a 1 h read timeout;
  `/assets/` cached for a year; everything else from `/var/www/mes` with
  the SPA fallback. After a change: `nginx -t && systemctl reload nginx`.
- **Backend settings** (drop-ins in
  `/etc/systemd/system/mes-backend.service.d/`): `override.conf`
  (`MQTT_URL`, `MQTT_CA_FILE`, `TRUST_PROXY=127.0.0.1`, `CORS_ORIGINS`),
  `bind.conf` (`HOST=127.0.0.1`), `ca.conf` (`NODE_EXTRA_CA_CERTS`, used
  for the Postgres connection). In code (`server.ts`): `TRUST_PROXY` unset
  → `trustProxy: false`; `CORS_ORIGINS` unset → no cross-origin request is
  allowed. The default of `HOST` in `config.ts` is still `0.0.0.0` — the
  drop-in is what keeps the backend off the network.
- **Frontend**: `api.ts` derives `WS_URL` / `API_BASE` from `location`
  when `VITE_BACKEND_WS_URL` is unset (https → wss). The old dev unit
  `mes-frontend` is disabled. Deploy = build on node-dc and copy
  `packages/frontend/dist/` into `/var/www/mes/`.
- **Postgres** (17, node-dc): `ssl` was already on with Debian's snakeoil
  certificate; `/etc/postgresql/17/main/conf.d/mes-tls.conf` now points
  `ssl_cert_file` / `ssl_key_file` at the CA-issued certificate in
  `/etc/postgresql/17/main/certs/` (owned by `postgres`, key `0600`) with
  `ssl_min_protocol_version = 'TLSv1.2'`. `pg_hba.conf`: the `host` lines
  (127.0.0.1, ::1, also replication) are `hostssl`; the `local ... peer`
  lines are unchanged, so `mes-backup.sh`, `mes-purge-machine-history.sh`
  and `mes-restore-test.sh` (all `runuser -u postgres` over the socket) are
  not affected. `DATABASE_URL` ends in `?sslmode=verify-full`; the backend
  trusts the CA through `NODE_EXTRA_CA_CERTS`. A certificate swap needs
  only `systemctl reload postgresql@17-main`. Check:
  `psql -d mes -Atc "select a.usename, s.ssl, s.version from pg_stat_ssl s join pg_stat_activity a using (pid) where a.usename='mes' group by 1,2,3"`
  → `mes|t|TLSv1.3`. Rollback files from the change: `/root/pg_hba.conf.bak`.
- **node-gate**: `mes-edge-node` is the enabled service (claims the node
  with its token and runs the channels assigned in the backend). Its
  drop-ins set `MQTT_URL=mqtts://192.168.60.141:8884`, `MQTT_CA_FILE`,
  `MQTT_CLIENT_CERT` / `MQTT_CLIENT_KEY` (`/etc/mes/mqtt-client/`, key
  `0600`, `mtls.conf`),
  `BACKEND_HTTP_URL=https://192.168.60.141`,
  `NODE_EXTRA_CA_CERTS=/etc/ssl/mes-ca.crt` and
  `EnvironmentFile=/etc/mes/edge-node.env` (holds `EDGE_NODE_TOKEN`,
  `0600`; create it with `read -rs`, never echo it). Healthy = nginx
  `access.log` shows one `POST /api/edge-nodes/claim` 200 and then a
  `heartbeat` 200 every 30 s from the node's IP. The `mes-edge-agent`,
  `-modbus`, `-opcua` units are the legacy single-machine mode, disabled
  on purpose; **do not start them alongside the edge node** (they publish
  the same machines twice). Token rotation: regenerate in Admin → Edge
  nodes, put the new value in `/etc/mes/edge-node.env`,
  `systemctl restart mes-edge-node`; a 409 "another instance of this edge
  node is already active" means the previous session lease has not expired
  yet (it cleared within 1–2 minutes). No token expiry logic was found.
- **Gotchas found while rolling out**:
  - Without `EDGE_NODE_TOKEN` in its environment the edge node starts in
    "legacy mode" with a default simulated machine (`sim-machine-01`, not
    in `machines`). Its events made the hourly production rollup fail with
    a foreign key error for every machine and the dashboard counts stopped.
    Check `tr '\0' '\n' < /proc/<pid>/environ | grep -c ^EDGE_NODE_TOKEN`.
    322 orphan events were deleted after a backup. Since `edge-agent-v4`
    the agent refuses to start without a token (see "Edge agent v4").
  - `systemctl daemon-reload` is needed after editing a unit or drop-in.
  - `systemctl cat <unit> | grep Environment` prints secrets; use
    `systemctl show -p Environment | tr ' ' '\n' | grep MQTT` instead.
  - node-dc's `curl` needs `--cacert /etc/ssl/mes-ca.crt`; node-gate has no
    `curl` — a Node `fetch` with `NODE_EXTRA_CA_CERTS` works.
  - Paste commands into zsh without `#` comment lines.

## Device certificates and MQTT access control — Oct 2

- **Two CAs, on purpose.** The server CA (`~/mes-ca`) signs the server
  certificates; the **device CA** (`~/mes-device-ca`, own passphrase, both
  offline on the admin laptop) signs one client certificate per device:
  `mes-ca.sh init-device`, `mes-ca.sh issue-device <name> <role>` (the name
  becomes the CN = the MQTT user name, the role the OU). Issued:
  `backend` (backend), `node-gate` (edge-node), `admin-laptop` (tool) and
  `node-sim` (unused: node-sim only runs the simulated PLCs
  `mes-modbus-simulator`, `-opcua-simulator`, `-plc-simulator`, which the
  edge node reads — they are not MQTT clients). Never share one certificate
  between two machines. Details and the test results are in `ops/ca/README.md`
  and `docs/SECURITY_REVIEW.md` 8.3.
- **Where the files are**: `/etc/mes/mqtt-client/{cert,key}.pem` on node-dc
  (backend) and on node-gate (edge node), directory `0700`, key `0600`;
  the broker side has `/etc/mosquitto/certs/device-ca.crt` and
  `/etc/mosquitto/acl.conf`. Client settings are systemd drop-ins:
  `mes-backend.service.d/{override,mtls}.conf` and
  `mes-edge-node.service.d/{override,mtls}.conf`.
- **ACL** (`/etc/mosquitto/acl.conf`, topics from `@mes/shared`:
  `mes/machines/<id>/events` edge → backend, `.../acks` backend → edge):
  `backend` reads `mes/machines/+/events`, writes `mes/machines/+/acks`;
  `node-gate` the reverse; `admin-laptop` reads `mes/#` and `$SYS/#`.
  Add a device = issue a certificate + add a `user <CN>` block +
  `systemctl reload mosquitto`; remove/revoke = delete the block + reload
  (the certificate stays valid until expiry, but its publishes are dropped
  and nothing is delivered to it).
- **Watching the traffic now**: anonymous `mosquitto_sub` no longer works.
  From the laptop: `mosquitto_sub -h 192.168.60.141 -p 8884 --cafile
  ~/mes-ca/issued/mosquitto/ca.crt --cert
  ~/mes-device-ca/issued/admin-laptop/cert.pem --key
  ~/mes-device-ca/issued/admin-laptop/key.pem -t 'mes/#' -v`.
- **Gotcha that stopped ingestion for ~5 minutes on Oct 2**: do not use
  `require_certificate false` together with `use_identity_as_username
  true` as a "transition mode". With `require_certificate false` Mosquitto
  does not even request a client certificate, and `use_identity_as_username`
  then refuses every client ("Connection Refused: bad user name or
  password"), certificate or not. The safe migration is a second listener
  (done: 8884 next to the old 8883), clients moved one by one, then the old
  listener removed. Test any Mosquitto config change on a throw-away broker
  first.
- **Gotcha in the edge-agent deploy script**: `scripts/deploy-edge-agent.sh`
  restarts every unit from its `SERVICES` list that appears in
  `systemctl list-units --all`; it was not checked whether it can start the
  disabled legacy `mes-edge-agent*` units or whether it knows
  `mes-edge-node`. The edge node was updated by hand instead:
  `git fetch origin --tags && git checkout edge-agent-v3`, `pnpm run build`
  in `packages/edge-agent`, one `systemctl restart mes-edge-node` (expect a
  few `409 already active` lines first).
- **Expiry**: all device certificates are valid for one year (October 2027).
  An expired device certificate stops that device, so the renewal reminder
  covers them too.

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

## Login rate limiting (`auth-throttle.ts`, `auth-routes.ts`)

`POST /api/auth/login` and `/api/auth/mfa/login` now live in
`auth-routes.ts` (registered in `server.ts` right after the auth guard).
Counters are rows in `auth_throttle` (`sql/032`), keyed per rule:

| Key | Limit | Lock |
|---|---|---|
| `pair:<email>\|<ip>` | 5 failures / 15 min | 15 min |
| `account:<email>` | 20 / 60 min (any IP) | 15 min |
| `ip:<ip>` | 30 / 15 min (any account) | 15 min |
| `mfa:<userId>` | 5 wrong codes / 15 min | 15 min |

- Locked → 429 with `Retry-After`; the password isn't checked at all.
- A correct password clears the pair and account counters, **not** the
  IP one (a single known password mustn't reset spraying protection).
- Unknown accounts: same message and same timing (dummy hash verified),
  counted the same way; emails are lower-cased/trimmed for the key.
- Audit: `login_locked` / `mfa_locked` once per lock, with the scope;
  individual blocked requests are journal-only (`authThrottle: "blocked"`).
- **Unlock someone by hand**:
  `psql -h localhost -U mes mes -c "DELETE FROM auth_throttle WHERE key LIKE '%user@example%';"`
- Old rows are pruned on successful logins (older than a day, not locked).
- **Behind a reverse proxy** (planned with TLS) set Fastify `trustProxy`,
  or every client shares the proxy's IP and the IP limit locks everyone out.
- Verified on node-dc: `401 ×5 → 429`, `retry-after: 900`, one
  `login_locked` audit row.

## Downtime periods and micro-stops

**Why there were 58k periods:** investigated Sep 30. Mostly the
simulators — `running`/`down` alternate ~50/50, the S7 rig about every
35 s with ~10 s stops. That's test-signal noise, not a backend bug; a real
line will look different. But three real problems surfaced and are fixed:

- **Split periods** (`downtime-periods-evaluator.ts`): the old evaluator
  treated every `down` event as a new period lasting until the *next
  event*, so `down → down → running` (e.g. a status re-sent after an edge
  reconnect) became two periods. Rare in the data (3 cases), but on a real
  line it'd turn one stop into several things to explain. A period is now
  "first `down` not preceded by `down`" → "first non-`down` after it".
  Migration 033 merged the existing split chains (carrying over a
  fragment's fault report if only it had one).
- **Full-history scan every minute**: the old query ran `LEAD()` over
  every status event ever recorded. Now per machine, from
  `LEAST(now() − 48 h, end of that machine's last recorded period)`: the
  48 h lookback catches events that arrive late from the edge agent's
  offline buffer, the `LEAST` makes sure a stop longer than 48 h that just
  ended is still recorded. The per-machine start is computed in a separate
  query on purpose — inlined into a CTE, Postgres recomputed it per event
  row (a first attempt took 136 s per tick). Now 0.12 s per tick, 1.2 s
  for a full-history backfill (120k synthetic events).
- **Micro-stops** (`sql/034`, `downtime-periods-repository.ts`,
  `DowntimePeriodsPanel.tsx`): `machines.micro_stop_threshold_seconds`
  (default 60, 0–3600, editable by admin/manager in the Downtime panel,
  audited as `machine_micro_stop_threshold_updated`). Shorter stops are not
  listed for explanation; they're summarized per machine
  (`GET /api/downtime-periods/summary?hours=24`: stops, stop time,
  micro-stops, micro-stop time, still to explain). Micro-stops are a
  performance loss to watch in aggregate, not something an operator
  reason-codes one by one. On node-dc this cut the list from 58,947 to 617.
- **Explain race**: `explainDowntimePeriod` checked "still unexplained",
  then created a fault report, then linked it — two near-simultaneous
  requests (a double click, which the panel didn't prevent) both passed
  and created two fault reports for one stop. The link is now a
  conditional update; the loser's report is deleted. The panel also locks
  the buttons while a save is in flight.
- **Pareto** (`GET /api/downtime-periods/pareto?hours=168&machineId=…`,
  `DowntimeParetoPanel.tsx`, Quality → Downtime): downtime *time* per
  reason, descending, with share and cumulative %, for 24 h / 7 d / 30 d,
  all machines or one. Classification: a non-rejected fault report → its
  code (even for a stop under the threshold — an explicit reason wins);
  else under the threshold → "Micro-stops"; else "Unexplained" (a
  rejected explanation lands here too). Codes are per machine; the
  all-machines view merges them by code + name, so the same fault entered
  differently on two machines shows as two bars — a shared fault-code
  catalog would fix that if the pilot needs it. The panel warns when less
  than 80 % of the above-threshold downtime has a reason, because the
  ranking isn't trustworthy until then.
- Only status `down` counts as downtime. Custom status definitions with
  `oeeCategory = counts_as_down` are not considered by the evaluator —
  none exist today; revisit if they're introduced.

## Time, rollups and retention prep — Sep 30

Preparing a retention policy for raw `events` (≈ 490 MB/week with three
simulated machines — the 32 GB node-dc disk would fill within the pilot)
meant checking everything that reads raw events. That surfaced three bugs:

1. **Shift boundaries were interpreted as UTC.** The database ran in
   `Etc/UTC` and the shift functions (`resolve_shift`, off-shift segments)
   never name a time zone, so 06:00 / 14:00 / 22:00 meant UTC — 2 h off in
   summer, 1 h in winter (23:00 Budapest came out as "afternoon"). Every
   per-shift count, shift OEE, the Gantt's off-shift shading and the
   scheduling windows were shifted. Fix: **`MES_TIMEZONE`** (default
   `Europe/Budapest`, validated at startup, `config.ts`) is the single
   source: it sets `process.env.TZ` for the Node process and
   `-c timezone=…` on every pool connection (`db.ts`), and
   `ensureDatabaseTimezone()` sets the database default on start (so ad-hoc
   `psql` shows local time too). Not only `ALTER DATABASE`, because
   **`pg_dump` doesn't carry database-level settings** — after a restore the
   bug would have returned silently. Stored timestamps are unchanged (UTC
   instants); shift summaries are computed on read, so past shifts are
   correct immediately. Multi-site will need a per-site zone (Phase 2).
2. **`production_counts_hourly` undercounted every hour since 2026-09-28.**
   The rollup recomputed "the last 3 hours" from `now() - 3 h` — mid-hour —
   so the oldest bucket was recomputed from a partial hour and `DO UPDATE`
   overwrote the correct value with a smaller one, every 5 minutes, until
   each hour kept only its last few minutes. Hours before 2026-09-28 were
   fine only because the initial backfill had filled them. Fix: window
   starts on an hour boundary (`date_trunc`) and covers 24 h (late,
   buffered events); a one-off full recompute repaired all 1,480 buckets.
   **Rule: a rollup that overwrites buckets must recompute whole buckets.**
3. **Migration 027 rebuilt the `events` primary key on every start**
   (unconditional `DROP CONSTRAINT` + `ADD PRIMARY KEY` on a 1.9M-row
   hypertable, table locked meanwhile — `migrate.ts` re-runs every file).
   Now guarded; restart-to-ready went from 5.0 s to 3.3 s, and it would
   have kept growing with the table.

Also added: **`machine_status_hourly`** (`sql/035`,
`status-rollup-evaluator.ts`) — seconds per status per machine per hour,
hour-aligned 24 h window every 5 min, full-history backfill on first start
(2.2 s for 120k events). **Preventive maintenance** (`usage_hours`,
`part_count`) now counts from the two hourly rollups instead of raw events
— independent of raw-event retention, and no longer re-reads months of
events every minute. The baseline hour is prorated (error ≤ one hour of
production).

**Raw-event retention** (`raw-event-retention-evaluator.ts`, every 6 h,
first run 10 min after start): drops `events` chunks older than
`MES_RAW_EVENT_RETENTION_DAYS` (default **90**; `0` = off; minimum 7) with
`drop_chunks` (TimescaleDB OSS has no `add_retention_policy`). **Dry run by
default** — `MES_RAW_EVENT_RETENTION_DRY_RUN=false` in `/etc/mes/backend.env`
turns deletion on; until then it only logs `would drop chunk`. Per chunk,
oldest first:

1. cutoff = LEAST(now − retention, now − 7 d, first `in_progress` transition
   of any still-open work order − 1 d) — work-order progress still reads raw
   events, so an open order holds retention back;
2. the chunk's hourly rollups are **recomputed from raw before dropping**
   (production counts; status seconds extended into the next chunk up to
   its first status event — those hours' starting state lives in this
   chunk, so later they can't be recomputed);
3. verify: raw production events in the chunk = rollup sum, else stop
   (nothing dropped, System alert);
4. `drop_chunks`, audit `raw_events_dropped` (actor
   `system:raw-event-retention`).

Every run writes `job_status` (`raw_event_retention`); a failure raises a
System alert that resolves on the next good run. The status rollup
(`rollupMachineStatus`) no longer overwrites hours whose starting state is
gone (raw truncated by retention but rollup history exists) — they keep the
values computed from full raw data. What reads raw events after this:
current shift / Overview / terminal (current shift only), status timeline
within the retention window (older: hourly dominant status from the
rollup), work-order progress (protected by the cutoff), downtime evaluator
(recent), `state.ts` (falls back to the rollup). Chunks are 7 days.

**Clocks:** the three LXC nodes share the Proxmox host's kernel clock —
time sync is the host's `chrony` (check on the host: `chronyc tracking`),
not something to configure in the containers. Event timestamps come from
the edge agent's clock and are compared with node-dc's `now()`, so **in a
real deployment the edge gateway (separate hardware) needs the same NTP
source as the server.**

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
- Server-side copies to weekly/ / monthly/ use --copy-props none: by default aws s3 cp copies tags too, which needs s3:GetObjectTagging — deliberately not granted to the node-dc IAM user. Found on the first monthly run (Oct 1).

## Maintenance on the Gantt — Oct 1

- Each machine row in `GanttSchedulePanel.tsx` now has two lanes: production
  on top (as before), maintenance below (`ROW_HEIGHT` 56 → 64). Open
  maintenance work orders with a planned window (sql 037) are drawn as
  striped grey bars; urgent ones get a red border.
- **Overlap rule: warn, don't block.** A maintenance window that overlaps a
  production segment of a non-completed, non-cancelled order on the same
  machine gets an amber border, and so does the production bar; both
  tooltips name the other side, and the toolbar shows "N maintenance
  windows overlap production". The planner decides — nothing is rejected.
  The check is client-side only (the server doesn't know about it); if a
  hard rule is ever wanted, it belongs in the two schedule endpoints.
- **Editing**: maintenance/manager/admin can drag a maintenance bar along
  its own machine row (it can't change machines here — the machine is part
  of the work order) and resize either edge; saved through
  `PATCH /api/maintenance-work-orders/:id` with `plannedStart`/`plannedEnd`
  (15-minute snap). Unplanned open maintenance appears in the left pool under
  "Maintenance to plan" and can be dropped onto its machine's row with a
  2-hour default window. Maintenance windows are not split around off-shift
  time.
- Production bars are now draggable only for admin/manager (the API already
  required that; before, other roles could start a drag that then failed).
- Not built yet: the overlap warning inside the work order and maintenance
  drawers, and a click-through from a bar to its drawer.

## Server-paged lists: audit log, alerts, fault reports — Oct 1

- **Shared pattern**: `GET` endpoints return `{ rows, total }` (the audit
  log keeps `{ entries, total }`), take `limit` (1–200, default 50) and
  `offset`, and validate them (`paging.ts`, unit-tested; 400 with `field`).
  `machineIds=a,b,c` narrows to the global scope's machines (`-` = an empty
  scope, matches nothing). Frontend: `ui/useServerList.ts` (debounced,
  resets to page 1 when a filter changes, ignores stale responses) and
  `ui/Pager.tsx`. Server-paged tables don't sort client-side — the order is
  the server's (newest first).
- **Audit log** (`AuditLogPanel.tsx`): time range, action (exact or a
  group like `work_order_*`, from `GET /api/audit-log/actions`), actor email,
  target id, free text (also searches `details`). Row → drawer with a
  before/after table for `changes` and the raw details; "Show all for this
  target" filters by the entry's target. Security-relevant actions
  (`login_failed`, `login_locked`, `mfa_*`, `raw_events_dropped`) are the
  only coloured ones. Export page to CSV. `limit` used to be unbounded.
- **Alerts** is now three views: **Active** (`AlertsPanel.tsx`: table, new
  ones first, bulk acknowledge, create ticket), **History**
  (`AlertHistoryPanel.tsx`, `GET /api/alerts/history?status&from&to&machineIds`
  — system alerts always included), **Rules** (`AlertRulesPanel.tsx`, admin
  and manager, new rule in a drawer). `/api/alerts` itself is unchanged
  (open + last 24 h) — the sidebar badge and the Overview use it.
- **Fault reports** (`FaultReportsPanel.tsx`): `GET /api/fault-reports/page`
  (`status` incl. `reviewed`, `q`, `machineIds`), default view "Pending
  review"; row → drawer with review (confirm, confirm with a corrected
  count, reject, note), corrective actions (log, sign off) and "Create
  maintenance work order"; "Report a fault" drawer.
  `GET /api/corrective-actions?faultReportId=…` loads only that report's
  actions (it used to return all of them). `/api/fault-reports` (full list)
  is kept for compatibility.
- **Scope now also applies to** Downtime (periods and summary client-side;
  the Pareto via `machineIds`, since it aggregates on the server), Machine
  history's machine picker, alert history and fault reports.

## Global scope selector and Overview redesign — Oct 1

- **Scope** (`scope.tsx`, `ScopeSelector.tsx`): a site → area → line picker
  in the top bar; the choice is kept per browser (`localStorage`) and reset
  if the saved site/area/line no longer exists. `useScope()` gives
  `isInScope(machineId)` (unknown machine or `null` → in scope, so system
  alerts and brand-new machines never vanish), the full machine list and
  the hierarchy. Applied to: Overview, Gantt rows, production work orders
  (unscheduled orders always show — they aren't tied to a machine yet),
  maintenance work orders, alerts, machine registry (shows an "Only …"
  pill on top of its own filters).
- **This is a display filter, not access control.** The API still returns
  everything the role may see. Per-user scoping (PRD 5.8) belongs on the
  server and can build on the same hierarchy.
- Not yet scoped: Machine history, Downtime (Pareto is aggregated
  server-side and would need a machine-set parameter), fault reports, lots.
- **Overview** (`MachineOverviewPanel.tsx`, rewritten): a KPI row for the
  scope (running x / y, down, average shift OEE, good parts and scrap rate,
  open alerts linking to Alerts) and compact machine tiles grouped by line
  (machines without a line under their area). ISA-101 colouring: only
  `down` is red, "no live data" is amber, off-shift is greyed, running is
  neutral. Down machines sort first within a group.

## Navigation: sidebar + one view per URL — Oct 1

- The tab bar and the stacked `CollapsibleSection`s are gone
  (`CollapsibleSection.tsx` deleted). `AppShell.tsx` is the frame: a left
  sidebar with two levels (module → view), a top bar with breadcrumb,
  connection state, role and sign-out, and exactly **one view** below.
- **Every view has a URL**: `/overview/live`, `/production/work-orders`,
  `/production/schedule`, `/maintenance/preventive`, `/admin/machines`, …
  (`router.ts`, History API, no dependency). Back button, bookmarks and
  shared links work. `/` and unknown or not-permitted paths redirect to the
  first view the role may see. `/terminal/:id` is unchanged (`main.tsx`).
  **The frontend is now a static build behind nginx** (since Oct 1) with an
  SPA fallback (`try_files $uri /index.html`), so deep links work.
- The navigation is defined once in `App.tsx` (`NAV`): modules, views and
  which roles see them, mirroring the backend checks (Admin: admin/manager;
  Audit log: admin; Preventive schedules: maintenance/manager/admin; Work
  instructions: admin/manager). `renderView()` maps `module/view` to the
  panel. New view = one entry in `NAV` + one `case`.
- Admin is split into separate views: Machines, Sites/areas/lines, Shifts
  and calendars, Status definitions, Fault codes (moved here from Quality —
  it's configuration), Terminals, Edge nodes, Audit log.
- The sidebar collapses to an icon rail (remembered in `localStorage`);
  below 900 px it becomes an overlay opened from the top bar. The Alerts
  entry shows the number of open, unacknowledged alerts (polled every
  60 s) — the only red element in the frame, per the ISA-101 direction.

## Work orders, maintenance and tables — Oct 1

- **Work orders as a table** (`WorkOrdersPanel.tsx`, `WorkOrderDrawer.tsx`):
  search, status (default "Open" = planned/released/in progress), machine
  (incl. "Not scheduled"), "Late only"; columns for machine, planned
  start/end and working time; bulk **Release** / **Cancel** (only planned →
  released, planned/released → cancelled; others are skipped and reported);
  CSV export; Copy. **The separate Scheduling panel is gone**: scheduling
  happens in the order's drawer through the same atomic
  `PUT/DELETE /api/work-orders/:id/schedule` the Gantt uses (machine, start,
  and either "working time from cycle time × quantity" — falling back to the
  machine's ideal cycle time — or a fixed end). Details and schedule are two
  separate actions on purpose: one button for both would be two
  transactions. `SchedulePanel.tsx` used the legacy per-segment endpoints
  that bypass the scheduling rules; it was deleted.
- **Work order API** (`work-order-routes.ts`, `work-order-input.ts`,
  unit-tested): `GET /api/work-orders` now includes `schedule` (machine of
  the first segment, min start, max end, working seconds, segment count).
  `PATCH` (and `PUT`, which the terminal calls) validates every field,
  clears nullable ones with `null`, runs in one transaction; **operators may
  only change `status`** (403 otherwise — previously an operator could edit
  any field). `POST /api/work-orders/bulk` (`release` | `cancel`).
  Completing via PATCH still generates the lot.
- **Watch out:** `computeWorkOrderProgress` finds the production start in
  `audit_log` (`work_order_updated` with `details.status = 'in_progress'`).
  The new audit details therefore keep the patch fields at the top level
  and put the diff under `changes`. A real `started_at` column would remove
  this coupling — worth doing before anything else touches that audit row.
- **DATE columns were shifted by a day in the API**: `pg` parsed `DATE` as
  local midnight, so `due_date = 2026-10-05` came out as
  `2026-10-04T22:00:00.000Z`. `db.ts` now returns DATE as a plain
  `YYYY-MM-DD` string (also fixes `material_lots.received_at`).
- **Maintenance planning prep** (`sql/037_maintenance_planning.sql`):
  `planned_start` / `planned_end` (both or neither, end > start, ≤ 14 days)
  and `priority` (low/normal/high/urgent). One window, not split around
  shifts — maintenance is often planned for nights/weekends. Planning on a
  deactivated machine → 409. Index `(machine_id, planned_start)` for the
  coming Gantt query.
- **Maintenance API** (`maintenance-routes.ts`, `maintenance-input.ts`,
  unit-tested): list includes planned window, priority, assignee id, labor
  hours and parts count. `PATCH`/`PUT` validated, one transaction, diff in
  the audit; assigning someone to an `open` job moves it to `assigned`;
  `closed_at` follows the status (reopening clears it — before, a reopened
  job kept its old close time); a closed job can't change machine.
  **Parts and labor logging are audited now** (`maintenance_part_logged`,
  `maintenance_labor_logged`) — the last known audit gap from PRD 8.8.
  `GET /api/users/assignable` (maintenance/supervisor/manager/admin).
- **Maintenance UI**: `MaintenanceWorkOrdersPanel` (table: priority —
  only high/urgent are coloured, status, assignee, planned window, labor;
  filters for status, machine, planned/not planned) with
  `MaintenanceDrawer` (job, responsibility, planned window, work log for
  hours and parts). `PreventiveSchedulesPanel` is a table with a "New
  schedule" drawer.
- **Next for the Gantt**: draw `maintenance_work_orders` with a planned
  window as a second bar type on the machine row (read-only first, then
  drag/resize via `PATCH plannedStart/plannedEnd`), and decide the overlap
  rule with production segments (warn vs. block).

## Plant hierarchy and machine registry UI — Sep 30 (evening)

- **Hierarchy** (`sql/036_plant_hierarchy.sql`): `sites` → `areas` →
  `lines` (ISA-95 Site/Area/Line). A machine **must** belong to an area and
  **may** belong to a line (standalone machines sit directly under the area).
  The site is derived from the area, not stored on the machine. A composite
  FK `(line_id, area_id) → lines(id, area_id)` makes a machine-on-a-line-of-
  another-area impossible; `ON UPDATE CASCADE` means moving a line to
  another area moves its machines too. All hierarchy FKs are `RESTRICT`
  (non-empty nodes can't be deleted → 409). Existing machines were placed
  under "Main site / General" by a **one-time, guarded** backfill (runs only
  while `machines.area_id` doesn't exist yet — no re-running
  `WHERE … IS NULL`, cf. 023). `machines.location` is kept as legacy
  free text; the new UI only shows it read-only.
- **API**: `machine-registry-routes.ts` replaces the old routes in
  `server.ts`. `GET /api/machine-registry?active=true|false` (no param =
  all). `PATCH /api/machine-registry/:id` (also `PUT`, for old clients)
  updates any subset of fields in **one transaction** — name, type, active,
  area/line, shift pattern, calendar, auto off-shift, ideal cycle time,
  micro-stop threshold; `null`/`""` clears nullable fields (the old
  `COALESCE` update couldn't). `POST /api/machine-registry/bulk`
  (`activate` | `deactivate` | `move`, ≤ 500 ids, all-or-nothing, rows
  locked in id order). Audit: `machine_updated` with only the changed
  fields (`changes: {field: {from, to}}`), one entry per machine for bulk
  actions. Validation: pure functions in `machine-input.ts`
  (unit-tested), errors are `400 { error, field }`. Hierarchy:
  `GET /api/plant-hierarchy` plus `POST/PATCH/DELETE /api/sites|areas|lines`,
  audited as `site_created`, `line_updated`, ….
- **Bugs fixed on the way**: `POST /api/machine-registry` dropped
  `idealCycleTimeSeconds`; new machines had no shift pattern/calendar until
  the next restart (023's re-run line filled them) — now defaulted on
  insert; the old registry panel's scheduling save ignored errors.
- **Deactivated machines**: selectors in all panels load
  `?active=true`; name lookups (Alerts, Status definitions) still see all
  machines. Scheduling a deactivated machine is rejected with 409 (new
  schedule endpoint and the legacy assignment POST). Reports (Pareto,
  downtime summary, shift summary) were already active-only in SQL.
- **UI foundation**: `theme.css` (design tokens, ISA-101 direction: neutral
  grey, colour only for abnormal states, one steel-blue for interaction);
  `ui/DataTable.tsx` (sorting, selection, row actions, dimmed rows — no
  filtering, the caller filters), `ui/Drawer.tsx` (side panel, Esc/backdrop
  close), `ui/csv.ts` (Excel-friendly export, formula-injection safe),
  `master-data.ts` (shared types, `readJsonOrThrow`, a tiny change
  notification so the hierarchy and machine panels refresh each other).
  `MachineRegistryPanel` is a searchable/filterable table with bulk bar and
  CSV export; editing/copying in `MachineEditorDrawer`;
  `PlantHierarchyPanel` is a three-column site/area/line browser. App
  container widened from 900 to 1280 px.
- **Next UI steps** (sidebar done Oct 1): move the other long lists (audit log, downtime
  periods, alerts, work orders, fault reports) onto `DataTable` — the
  unbounded ones with server-side paging; sidebar navigation and a global
  site/area/line scope selector; replace the scattered inline colours with
  tokens; `WS_URL`/`API_BASE` dedup.

## Unknown machine ids are dropped — Oct 2

- `packages/backend/src/machine-registry-cache.ts`: `createMachineRegistryCache(load, now, ttlMs=30000, missRefreshMs=3000)`
  returns `isRegistered(machineId)`. Known ids are cached for 30 s; an
  unknown id triggers a reload at most every 3 s (new machines are accepted
  within seconds); concurrent reloads share one query. No `db` import, so it
  is unit-tested without `DATABASE_URL` (`__tests__/machine-registry-cache.test.ts`, 6 tests).
- `mqtt-subscriber.ts`: before storing, `registeredMachines.isRegistered(event.machineId)`.
  Unknown id → ack + drop + `noteUnknownMachine` (warn, max once per 5 min per
  id, with the dropped count; message "dropped events from a machine id that
  is not registered"). Lookup error → log error, **no ack**, the edge agent retries.
- `production-rollup-evaluator.ts`: `FROM events e JOIN machines m ON m.id = e.machine_id`.
  `status-rollup-evaluator.ts` needed no change (ids come from `machines`).
- Why ack and not just ignore: the edge agent republishes every unacked
  event every 4 s, so an ignored event would loop forever and the buffer would grow.
- End-to-end test (Oct 2): temporary ACL for `admin-laptop` (write on
  `mes/machines/ghost-test-01/events`), two `machine_status` events from the
  laptop with `mosquitto_pub`, both acked, one warning in the backend log,
  `count(*)` = 0. The ACL was restored from `/root/acl.conf.pre-e2e`.
  Not added on purpose: a topic vs payload `machineId` check (a bug there
  would stop all ingestion).

## Licensing and device onboarding — Oct 2

- **Licensing** (`docs/LICENSING.md`): signed license file (`mes-license-v1`,
  Ed25519, offline vendor key `~/mes-license-key`), vendor tool
  `ops/license/mes-license.mjs`, verification in `license.ts`, policy in
  `license-policy.ts`, service/evaluator in `license-service.ts`, endpoints
  and guard hook in `license-routes.ts`, table `license_state` (migration 038).
  Ships in **audit mode** (`LICENSE_ENFORCE=false`, the default): state is
  computed and shown (`GET /api/license`, system alert `license_health`) but
  nothing is restricted. Enforcement only touches configuration routes
  (machine registry, edge nodes/channels, alert rules, sites/areas/lines) and
  node creation at the licensed count; data collection is never blocked.
  Terminals are not counted yet (no identity for them).
- **Onboarding scripts** (`ops/onboarding/`): `new-edge-node.sh` (laptop),
  `mosquitto-device-acl.sh add|remove|list` (node-dc), `install-on-node.sh`
  (new node, with a mutual-TLS preflight). See its README.
- Lesson: OpenSSL 3 `s_client` prints `Verify return code: 0 (ok)` even after
  an aborted handshake; a TLS check must also require a real cipher and no
  error/alert line (`tls_ok` in `install-on-node.sh`).

## Certificate expiry monitoring — Oct 2

- Admin laptop: `mes-ca.sh status [--warn N]` lists every certificate of
  both CAs with days left (exit 2 if any <= 60 days); `mes-ca.sh ics` writes
  one all-day reminder per certificate, 30 days before expiry. Portable
  (macOS and Linux): days are found by a binary search on `openssl -checkend`,
  not by parsing dates.
- node-dc: `ops/monitoring/mes-cert-check.sh` + `mes-cert-check.{service,timer}`
  (daily 05:15 UTC), installed by `ops/monitoring/install-cert-check.sh`.
  Checks the Mosquitto server cert, both CA roots, the nginx cert, the
  Postgres cert, the backend device cert and `/etc/ssl/mes-ca.crt`; extra
  paths go in `/etc/mes/cert-check.paths`. Records the result in
  `job_status` (`cert_expiry`) the same way `mes-backup.sh` does.
- Backend: `cert-health-evaluator.ts` (system alert `cert_health`), started
  from `index.ts`; the decision logic is in `cert-health.ts` (no db import,
  so its test runs without `DATABASE_URL`). Install the timer first, then deploy the evaluator,
  otherwise it reports "no check recorded yet".
- When a certificate is renewed, nothing needs to be told to the monitor: the
  next daily run reads the new file and the alert resolves by itself.

## CA rollover and certificate renewal — Oct 7

**What happened.** The passphrase of the server CA key (`~/mes-ca/root.key`,
created Oct 1) was lost (see `CHAOS_TEST_FINDINGS.md` slice 11, finding 12). A
new server CA was created on the admin laptop on Oct 7 (11:48 UTC, valid until
Oct 4, 2036, same subject `O=MES Pilot, CN=MES Pilot Root CA`, SHA-256
fingerprint `49:91:D9:16:...:4D:6F:1C`; the old one was `69:FE:0F:54:...:EA:33:43`).
The old directory was renamed `~/mes-ca-old` (its key cannot be opened; delete
it after the transition). The device CA (`~/mes-device-ca`) was not touched, so
no device certificate, ACL entry or MQTT client setting changed.

**State now.** Server certificates, all issued Oct 7 11:51 UTC and valid until
Oct 7, 2027: `mosquitto` (SAN `DNS:mes.pilot.internal, IP:192.168.60.141`),
`proxy` (same SAN) and `postgres` (`DNS:localhost, IP:127.0.0.1,
DNS:mes.pilot.internal`). Installed at `/etc/mosquitto/certs/{cert,key}.pem`,
`/etc/nginx/certs/{cert,key}.pem` and `/etc/postgresql/17/main/certs/{cert,key}.pem`.
`/etc/ssl/mes-ca.crt` on node-dc and node-gate and `/etc/mosquitto/certs/ca.crt`
hold only the new root. The admin laptop's macOS system keychain trusts the new
root (`sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/mes-ca/root.crt`);
the old root can be removed from it. `mes-ca.sh status` and the node-dc monitor
show the new dates.

**Procedure used (no outage of the trust chain)** — reuse it for any change of
root; the same steps without 1 and 4 renew only a server certificate:

1. Trust both roots first. On node-dc and node-gate append the new `root.crt` to
   `/etc/ssl/mes-ca.crt` (keep a `cp -a` copy), then restart `mes-backend` and
   `mes-edge-node`: `NODE_EXTRA_CA_CERTS` and `MQTT_CA_FILE` are read only at
   start, and a PEM file with two certificates works. Check that data still
   flows.
2. Issue the server certificates on the admin laptop (`mes-ca.sh issue mosquitto ...`,
   `proxy`, `postgres`, with the SANs of the old ones; read them from the old
   certificate with `openssl x509 -noout -ext subjectAltName`), copy them to a
   staging directory on node-dc.
3. Per service: back up the live files with `cp -a` and check the backup with
   `test -s`; check that certificate and key belong together; install with
   `cat new > live` (the live file keeps its owner and mode: broker key
   `root:mosquitto 0640`, nginx files `0600`, Postgres files owned by `postgres`,
   key `0600`); then `systemctl restart mosquitto`, `nginx -t && systemctl reload nginx`,
   `pg_ctlcluster 17 main reload`. Check from outside: `openssl s_client` against
   8884 and 443 with `-CAfile` of the new root and `-verify_hostname`, the
   events' age, `NRestarts`. The backend reaches Postgres with
   `sslmode=verify-full` and no `sslrootcert`, so it trusts the Postgres
   certificate through `NODE_EXTRA_CA_CERTS`.
4. Reduce the trust files to the new root alone, restart the backend and the
   edge agent again, run `systemctl start mes-cert-check.service`, and delete
   the staged private keys.
5. On every other client that trusts the old root (laptops, later the terminal
   tablets) install the new one before step 3, or the browser warns.

**Short-lived test certificate.** `make-short-cert.py` (admin laptop,
`~/mes-ca-tools`, not in the repository) issues a server certificate that is
valid for a few minutes, for testing an expiry. It needs the CA passphrase and
writes only to `~/mes-ca/issued/mosquitto-short`; delete that directory and the
copy on the server afterwards.

**CA passphrase rule.** Store the passphrase of each CA key in the password
manager **and** on paper in a second place before running `mes-ca.sh init` or
`init-device`. A CA key without its passphrase cannot issue or renew anything,
and replacing a CA after the pilot has started means touching every edge node
and every terminal.

## Edge agent v4: no silent legacy mode, Oct 2

- `edge-agent-v4` (commit `cc54438`, tests `5a9c36c`): without
  `EDGE_NODE_TOKEN` the agent logs `EDGE_NODE_TOKEN is not set - refusing to
  start ...` and exits with code **78**. The old single-machine mode must be
  asked for explicitly with `EDGE_AGENT_LEGACY=true` (any other value than
  `true`/`false` is a startup error). The decision is a pure function in
  `packages/edge-agent/src/start-mode.ts` (8 tests); `index.ts` only acts on it.
- Checked before deploying: node-gate has one unit, `mes-edge-node`, with a
  token in `/etc/mes/edge-node.env`; node-dc has no edge units; node-sim runs
  only the three simulators. Deployed by hand on node-gate (checkout tag,
  build, restart), verified: the service runs, and `env -u EDGE_NODE_TOKEN
  node dist/index.js` prints the refusal and exits 78.
- **Restart takes about 70 seconds.** The backend lets a new instance in only
  when the previous heartbeat is older than `HEARTBEAT_STALE_SECONDS`
  (`edge-nodes-repository.ts`); until then the new process dies with
  `another instance of this edge node is already active` and systemd restarts
  it every ~5 s (`NRestarts` reached 15). Nothing is collected from the
  machines during that time: expect a gap of about a minute in the data on
  every edge-agent restart. **Fixed for clean restarts in v5** (the session
  is released on SIGTERM, see "Edge agent v5 and v6"); a crash still waits.
- Two edge-agent tests (`gpio-` and `s7-signal-source`) had been failing
  since `58b141c` (custom status names allowed, a bridge that exits reports
  `down`); they now assert that behaviour.

## Edge agent v5 and v6 — Oct 5

Full release notes: `docs/EDGE_AGENT_RELEASES.md`; test results:
`docs/CHAOS_TEST_FINDINGS.md` (slices 3 and 4).

- **Catch-up** (`catchup.ts`, `counter-baseline.ts`, `python/catchup.py`): the
  last PLC counter values are stored in `counters.<machineId>.json` next to
  the buffer (`/var/lib/mes-edge`). After an agent start or a lost PLC
  connection the difference is booked if the gap is not longer than
  `catchupMaxMinutes`; longer gaps are dropped with a warning naming the lost
  parts (event timestamps are the booking time, so a long gap would land in
  the wrong hour/shift). Counter going backwards = PLC reset = new baseline;
  more than 5000 parts at once = dropped.
- **Per-node settings**: `edge_nodes.settings` jsonb (migration 039),
  `GET/PATCH /api/edge-nodes/:id/settings` (admin/manager, audited
  `edge_node_settings_updated`, counts as configuration for the licence
  policy), delivered in the `claim` response, applied on the next agent
  start. Editable in Admin -> Edge nodes since the evening of Oct 5 (see
  "Edge node and channel editing").
- **Lease release**: `POST /api/edge-nodes/release` (public route like
  `claim`, authenticated by token + session id; also in the licence
  `NEVER_RESTRICTED` list). The agent calls it on SIGTERM, so a clean restart
  is picked up at once. A crash or `kill -9` still waits ~90 s
  (`HEARTBEAT_STALE_SECONDS`); the catch-up books the parts of that wait if
  it is within the limit. The first start of v5 over v4 loops on `already
  active` for ~90 s once.
- **v6**: `runRegistryMode` no longer waits for the first MQTT `connect`;
  the ack topic is subscribed on every `connect`; shutdown is forced after
  5 s. Only `index.ts` changed, so there is no unit test - verified live
  (broker stopped, agent restarted: channels up at once, buffers filled,
  drained after the broker came back, DB = PLC counter difference).
- **Deploy**: still by hand on node-gate (`git fetch --tags`, checkout the
  tag, `pnpm install --frozen-lockfile`, build `@mes/shared` **and**
  `@mes/edge-agent`, `systemctl restart mes-edge-node`). `deploy-edge-agent.sh`
  was fixed on Oct 5 (commit `6fe6543`: knows `mes-edge-node`, installs
  dependencies, builds `shared` too, restarts only running units, waits for
  `claimed edge node`) but has **not been run on node-gate yet**; the manual
  way stays valid. node-gate's checkout had a stale `shared` build, which is
  why `shared` is built first. Backend
  first when a release needs a new endpoint (v5 did; v6 does not).
- **Chaos tooling**: `ops/chaos/buf-snap.sh` (buffer size and time span per
  machine), `ops/chaos/chaos-svc.sh` (stop a service for N seconds). A DB
  comparison after a test needs both a lower and an upper time bound per
  machine (the `seenAtMs` of the counter files before and after).
- Onboarding (`ops/onboarding/install-on-node.sh`) now generates units with
  `StateDirectory=mes-edge` and `BUFFER_FILE_PATH=/var/lib/mes-edge/buffer.ndjson`.
  The buffer is appended without `fsync`: a power cut can lose the last
  second or two.
- **node-gate reboot test passed** (Oct 5, `CHAOS_TEST_FINDINGS.md` slice 5):
  reboot with the broker down and a non-empty buffer; buffer and counter files
  survived, the agent came back by itself with a released lease and started the
  channels without the broker, and the database matched the PLC counter
  differences exactly (85/6, 81/4, 43/4).
- **node-gate hard stop test passed** (Oct 5, slice 6): `pct stop` with the
  broker down and a non-empty buffer; no invalid buffer lines, lease wait
  about 71 s, catch-up booked the gap, database equal to the PLC counter
  differences (113/8, 115/7, 62/6). A real power cut (unsynced appends) is
  still untested.
- **10 minute catch-up limit tested live** (Oct 5, slice 7): agent stopped
  for 11.6 min with the standard limit; the gap was dropped, the log named
  the lost parts per machine, and the database equals the PLC counter
  difference minus the lost parts exactly. The lost counts exist only in the
  journal of the edge node (idea: record a dropped gap as an event or alert).
- **Clock skew of the edge node tested** (Oct 5, slice 9, agent clock +15
  min with libfaketime): the backend accepts future-dated events without any
  warning; the current status is taken from the event with the latest
  timestamp in five places, so future-dated events hide real status changes
  (seen in the data: real `down` periods older than a future `running`); a
  clock step in either direction makes the catch-up drop its gap (no wrong
  booking). **Done in edge-agent-v7 / `b4f5f21` (Oct 5):** the agent sends its
  clock with claim and heartbeat, `edge_nodes.clock_offset_ms` (migration 041),
  the Edge nodes page shows "clock: in sync / 120 s ahead" (red above 30 s),
  the agent logs a skew above 30 s, new units wait for `time-sync.target`
  (node-gate got the drop-in by hand); verified live with a +2 min clock.
  **Follow-up, same evening (Oct 5):** system alert `edge_clock_skew` when an
  online node's clock differs by more than 30 s in either direction
  (`36d89da`, evaluator every 60 s, resolves by itself); ingestion guard — an
  event stamped more than 60 s in the future is stored with the receive time,
  original in `payload.timestampCorrected`, warning in the backend log
  (`689caaa`); catch-up log reason `clock_back` instead of `too_old` for a
  state from the future, TS and Python (`d2d6c27`, **edge-agent-v8**, deployed
  on node-gate). Alert and guard verified live with a +2 min clock (see the
  findings doc, "Alert, ingestion guard and log reason"). **Still open:** the
  agent correcting its timestamps with the server time; a guard for timestamps
  far in the past.
- **Postgres stopped on node-dc tested** (Oct 6, slice 10, 3 min 28 s then
  2 min 9 s): the first run showed that an unhandled pg Pool error
  (`57P01` on the stop) crashed the backend, which then looped until Postgres
  returned; **fixed in `1091e82`** (`pool.on("error")` in `db.ts`). With the
  fix the backend stays up (same `MainPID`, `NRestarts=0`), the edge acks
  nothing and buffers (40 / 40 / 34 events), and after the start the data in
  the database matches the buffer contents exactly, without a backend restart.
  Not done: a 503 "database unavailable" instead of the plain 500 on the
  dashboard, a real full-disk test (the disk-usage alerts below are done).
- **Disk usage alerts** (Oct 6): `disk_space` for node-dc (`50a8deb`) and
  `edge_disk_space` for the online edge nodes (`6777626`, **edge-agent-v9**,
  migration 042; the agent sends the disk of its buffer directory with claim and
  heartbeat, the Edge nodes page shows "disk: 42% used, 8.5 GiB free", red when
  low). Raise at 85 % used or < 2 GiB free, clear at 80 %; settings
  `DISK_WARN_PERCENT`, `DISK_MIN_FREE_GIB`, `DISK_CHECK_PATHS`. Verified live by
  lowering the limit (see the findings doc, slice 10). `pnpm test` is green:
  shared 6, edge-agent 43, backend 157.
- **Retry storm after a long outage fixed** (Oct 7, `f9a6eaa`, **edge-agent-v11**
  and backend, slice 12): a 4 minute network partition (packets dropped, not
  refused) lost no data, but after it the edge agent republished its whole buffer
  every 4 s while the backend was still working through it (about 2000 duplicates
  for 350 events, 70 `duplicate key` errors/s for 30 s), which kept the backend at
  45 % CPU and made the Alerts page take 10 to 35 s. Now: paced retry (an event is
  republished only after 15 s, at most 300 per sweep, forgotten on reconnect), acks
  removed from the buffer in batches, `INSERT ... ON CONFLICT DO NOTHING` in the
  backend, and MQTT `keepalive: 15` / `connectTimeout: 10000` (detection 90 s to
  21 s, reconnect cycle 32 s to 12 s). Re-run: 0 duplicate errors, 1 s of CPU peak,
  no request over 1 s, no data lost. Deploy: backend first, then the agent. 16 new
  tests.
- **Edge nodes' client certificates watched** (Oct 7, `790a1d9`,
  **edge-agent-v10**, migration 043): the agent reports the expiry of its client
  certificate with claim and heartbeat, the backend stores it
  (`edge_nodes.client_cert_expires_at`), the Edge nodes page shows it and the
  system alert `edge_cert_expiry` opens within 30 days of the expiry
  (`EDGE_CERT_WARN_DAYS`), checked every 10 minutes, resolves by itself. Verified
  live with `EDGE_CERT_WARN_DAYS=400` (temporary drop-in, removed): the alert
  appeared for `node-gate-sim` (360 days) and resolved after the removal.
  `pnpm test` is green: shared 6, edge-agent 45, backend 176.
- **Expired broker certificate tested** (Oct 6 to 7, slice 11): the monitor and the
  `cert_health` alert were checked with a shifted date, then with a real
  certificate valid for 12 minutes. After the expiry the backend and the edge
  agent retry every 2 s with `certificate has expired`, the backend stays up, the
  edge buffers (61 / 62 / 40 events) and, once the original certificate is back,
  replays them without an agent restart; database = buffer contents exactly.
  The test exposed that the server CA passphrase had been lost, so the CA was
  replaced (see "CA rollover and certificate renewal"). The moment of expiry
  on open connections was tested later (finding 16): they keep working, only
  new handshakes fail, nothing is lost. The edge nodes' client certificates
  are monitored since edge-agent-v10 (finding 17).
- **`systemctl stop` with the broker down tested** (Oct 5, slice 8): 0.018 s,
  unit state `inactive`, lease released (HTTP to the backend), next start
  claimed at once and caught up the 75 s gap.
- **Edge node "last seen" after a clean stop fixed** (Oct 5, `8bdc397`): the
  Edge nodes page showed `last seen: never` because the release clears
  `last_heartbeat_at` (it drives the online state and the lease). New column
  `edge_nodes.last_seen_at` (migration 040) is set by claim, heartbeat and
  release; the page shows it. Online state and lease logic are unchanged.
  Four unit tests (`edge-nodes-last-seen.test.ts`); checked live (stop: heartbeat
  empty, `last_seen_at` = stop time, page shows it).

## Edge node and channel editing — Oct 5

Commit `336b584`. The Admin -> Edge nodes screen (`EdgeNodesPanel.tsx`,
rewritten) now edits what used to need the database or a delete and re-add:

- **Node setting**: "Catch-up limit (minutes)" on the node card
  (`PATCH /api/edge-nodes/:id/settings`); Save is enabled only for a changed
  value. New node settings go into the same form.
- **Channels** show their connection (e.g. `host:port · unit`) and have an
  **Edit** form: machine, status mode, no-signal timeout / accept production
  while down, and every connection field of the protocol. The protocol itself
  cannot be changed (remove and add a new channel). Server errors name the
  field and the input is marked red. Node removal, token regeneration and
  channel removal ask for confirmation.
- **`PATCH /api/edge-node-channels/:channelId`** (`edge-node-routes.ts`,
  admin/manager): partial update. In `connectionConfig` a key set to `null`
  is removed, other keys are set, keys not mentioned stay (so unknown keys
  of hand-made channels survive). No change = no write and no audit entry;
  otherwise audit `edge_node_channel_updated` with `changes: {field: {from,
  to}}`. Unknown machine -> 404 `{field: "machineId"}`. The licence policy
  already treated `/api/edge-node-channels` as configuration.
- **Validation** (`edge-node-channel-input.ts`, pure, 12 + 4 tests): known
  connection keys are checked for type and range (Modbus port 1-65535, unit
  0-255, registers 0-65535; OPC-UA endpoint `opc.tcp://...`; S7 rack 0-7,
  slot 0-31, port 1-65535; GPIO pin number or name); required: Modbus `host`,
  OPC-UA `endpointUrl`, S7 `plcIp`. Strings are trimmed, unknown keys kept.
  On a PATCH the merged connection is re-validated only when the patch
  touches it, so a legacy channel with an odd config can still be moved to
  another machine. `POST /api/edge-nodes/:id/channels` uses the same
  validation now (before, any JSON was stored and a bad address showed up
  only in the agent log); existing channels are not touched.
- **A change is applied when the agent next starts** (it reads its channels
  from the `claim` response) - the screen says so. Not built: a restart
  button, or the agent noticing a change through the heartbeat.
- Tests: `edge-node-channel-input.test.ts`, `edge-node-channel-routes.test.ts`
  (and the mock in `edge-node-routes.test.ts`). The panel itself was checked
  with a throw-away DOM test (jsdom + testing-library: shows the connection,
  saves the limit, edit with a field error, confirm on remove, add with blank
  fields left out) that is not in the repo - the frontend has no jsdom or
  testing-library dependency.
- **Not covered by the dashboard on purpose**: issuing the device certificate
  and the Mosquitto ACL entry for a new edge node (`ops/onboarding/`,
  `new-edge-node.sh` on the admin laptop, `mosquitto-device-acl.sh` on
  node-dc, `install-on-node.sh` on the device) - the CA keys are offline.
- Lesson: `AuditEventInput.details` is `Record<string, unknown>`; an
  interface-typed object does not fit it (no index signature) - pass
  `{ ...value }`.

### Machine editor: data source (commit `6730489`)

- `MachineEditorDrawer.tsx` has a **Data source** section
  (`MachineDataSourceSection.tsx`, outside the machine `<form>` because forms
  cannot be nested; it saves on its own): the channel(s) feeding the machine
  with the edge node's online state, **Edit** (same fields and server errors
  as in Admin -> Edge nodes), **Disconnect** (PATCH `machineId: null`, asks
  first), **Connect an unassigned channel**, **+ Add new data source** (node,
  protocol, fields; assigned to this machine). Only for admin/manager (the
  edge node API is restricted to them); a new machine shows "Save the machine
  first". No backend change.
- `edge-channels.ts` is the shared module of this section and of
  `EdgeNodesPanel.tsx`: types, the connection fields per protocol, form <->
  API body conversion, `api()` helper (apiFetch + `readJsonOrThrow`, errors
  are `ApiError` with the server's `field`). A new protocol field goes into
  `FIELDS` there and shows up in both screens - and in
  `edge-node-channel-input.ts` on the backend for validation.
- The ideal cycle time field accepts a decimal comma (`1,5`).

### Machine editor: related configuration (commit `e63fc65`)

- `MachineRelatedSection.tsx` (below the data source section, edit mode,
  admin/manager only, read only): fault codes (active / inactive), alert
  rules (for this machine, and active ones that apply to all machines),
  preventive schedules (active / inactive) and the terminals the machine is
  on, each with a link to its admin view (`/admin/fault-codes`,
  `/alerts/rules`, `/maintenance/preventive`, `/admin/terminals`) that opens
  in a new tab, so the editor's unsaved changes stay. Gaps are spelled out
  (no fault codes: operators cannot give a reason; no alert rules: a long
  stop raises no alert; no terminal: operators cannot report from the
  machine).
- Backend: `GET /api/machine-registry/:id/related` (admin/manager;
  `machine-related-routes.ts`, shaping in the pure `machine-related.ts`):
  counts from `machine_fault_codes`, `alert_rules` (`machine_id` NULL = all
  machines), `preventive_maintenance_schedules`, and the terminals from
  `terminal_ui_machines`. 404 for an unknown machine. No schema change.
  Registered in `server.ts` right after `registerEdgeNodeExtras(app)`.
- Lesson (tests): a vitest `beforeEach(() => mock.mockReset())` returns the
  mock, which vitest then calls as a cleanup function after the test with
  no arguments - use braces.

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

- **Edge agent follow-ups** (Oct 5): an agent restart
  button / automatic pickup of changed channel settings (today a change is
  applied when the agent next starts);
  `packages/frontend/tsconfig.tsbuildinfo` is tracked in git
  (run `git checkout` on it before commits, or untrack it); run the tests with
  `pnpm test` in the repository (vitest is already a devDependency of the three
  packages; the gpio/s7 tests no longer use a fixed 400 ms wait and the backend
  config gives `DATABASE_URL` a dummy default, `8e6e532`); do not call `npx vitest`
  from the root (it downloads its own copy and also picks up `dist/`);
  `test_s7_bridge.py` needs the `snap7` module (missing on node-dc, so the
  Python test run there shows one import error; node-gate runs 18 tests OK);
  a dropped catch-up gap (longer than `catchupMaxMinutes`) is only visible in
  the journal of the edge node — consider recording it as an event or an alert.
- **Chaos tests not done yet**: a real power cut of the edge hardware (the
  clean reboot and the `pct stop` hard stop passed on Oct 5, see
  `CHAOS_TEST_FINDINGS.md` slices 5 and 6), the settings API with a real session,
  `systemctl stop` with the broker unreachable by dropped packets (refused
  connection tested, slice 8), disk full on node-dc (the Postgres stop was tested, slice 10), network
  partition, an edge clock *behind* the server (the clock ahead was tested, see
  `CHAOS_TEST_FINDINGS.md` slice 9). The expired broker certificate was tested on
  Oct 6 to 7 (slice 11).

- **Database outage follow-ups** (Oct 6): answer 503 with a clear message
  (instead of 500) when the database is unreachable, and show it on the
  dashboard. The edge buffer has no size limit in the code (only the disk of
  the device, now watched by `edge_disk_space`).
- **Certificates and CA** (Oct 7): store the new server CA passphrase and the
  device CA passphrase in the password manager and on paper (second place) if not
  done yet; delete `~/mes-ca-old` and remove the old root from the macOS keychain
  once the transition is accepted; run `mes-ca.sh ics` again for the new expiry
  dates and remove the old calendar reminders; the edge nodes' client
  certificates are watched since v10 (finding 17), the broker's and the others
  by `mes-cert-check.sh`.
- **Edge node offline alert** (chaos finding 20): a node that is unreachable for
  minutes raises no alert today. Proposed `edge_node_offline` system alert after 3
  minutes without a heartbeat, resolving by itself. Also check the resend of a
  future-stamped event (the unique index includes the timestamp, see slice 12).
- **External heartbeat** for node-dc itself (backup alerting can't fire
  if the host is down) — decide before the pilot whether it's needed.
- **Raw-event retention looks live**: the backend's startup log on Oct 1
  shows `retentionDays: 90, dryRun: false`. Confirm that was intended (the
  default is dry run, meant to be reviewed first) and check `audit_log`
  for `raw_events_dropped` entries.
- **Test-data cleanup before the pilot**: the simulator rigs produced
  ~120k status events and ~59k downtime periods. If the pilot runs on this
  database, clear the test machines' data first so reports start clean
  (a scoped cleanup script, not ad-hoc SQL).
- `mfa_pending_logins` stores raw pending tokens — hash like sessions
  (low risk, low effort).
- **Incident response**: `docs/INCIDENT_RESPONSE.md` is a draft — fill in
  contacts, customer timelines and legal's notification scope before the
  first external customer. Machine-history purge for the pilot:
  `ops/maintenance/` (dry run by default; not run yet).
- TLS is done on every path (see "TLS on every path"). Next security
  items per `docs/SECURITY_REVIEW.md`: the CA on the terminal tablets; the
  a CRL if revocation by
  ACL is not enough; a
  real DNS name instead of `mes.pilot.internal` (then re-issue the
  certificates); (the October 2027 renewal reminder is done: `mes-ca.sh ics` and the
  node-dc expiry monitor, see "Certificate expiry monitoring").
- Licensing: format, tool and backend wiring are done (audit mode). Open:
  issue a license and switch `LICENSE_ENFORCE=true` after a trial period,
  count terminals (needs a terminal identity), a UI banner/upload.
- The legacy per-segment endpoints (`/api/work-order-assignments` POST/PUT/
  DELETE) have no UI caller left (SchedulePanel removed) — retire them
  unless an integration needs them.
- Work order `started_at` lives only in the audit log (see "Work orders,
  maintenance and tables").
- Several config mutations still write **no audit event**: shift pattern
  / shift / calendar create-update-delete and `PUT
  /api/machine-registry/:id/scheduling`. PRD 8.8 expects configuration
  changes to be audited.
- The old per-segment assignment endpoints bypass the scheduling business
  rules — either route them through the same checks or retire them once
  it's clear no integration needs them.
- Cleanup: 25 frontend files each recompute `WS_URL` / `API_BASE`;
  `api.ts` now exports `API_BASE`, so these can become imports.
- "Additional MES ideas" floated earlier (CSV/PDF export, an andon board,
  downtime Pareto analysis, multilingual work instructions) — not started.

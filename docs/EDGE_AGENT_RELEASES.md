# Edge Agent Release Process

**Scope:** `packages/edge-agent` and its Python bridge scripts
(`packages/edge-agent/python/*.py`) — the code that runs on node-gate and
talks to the actual machines. This does NOT cover the backend or frontend,
which deploy differently (direct `git pull` + `pnpm run build` +
`systemctl restart`, per `DEVELOPMENT_STATUS.md`).

## Why git tags instead of cryptographic signing

PRD Section 8.6 asks for edge updates to be "staged" (not forced
immediately) and "reversible" (a failed update should roll back
automatically rather than bricking a device mid-production). A full
PKI-based signing scheme — where the edge agent verifies a cryptographic
signature before accepting an update — is the eventual, formal answer to
this, but Section 8.1's own phasing logic applies here too: that
infrastructure is reasonable to build once a real customer's security
requirements demand it, not speculatively for a one-node internal pilot.

What this process gives instead: every deployed version is a named,
immutable git tag, deployment is a single deliberate command (never
automatic), and rolling back to the previous version is equally a single
command — reversible in practice, even without a cryptographic
verification step. If a customer later requires signed updates, this
tagging discipline is exactly the foundation that scheme would build on.

## Cutting a release

Once a change to the edge agent has been tested and is ready to deploy:

```bash
scripts/tag-edge-agent-release.sh "add reconnection logic to ModbusSignalSource"
```

This tags the current commit as the next `edge-agent-vN` and pushes the
tag to GitHub.

## Deploying a release

On node-gate:

```bash
git pull origin main          # make sure the tagged commit is available locally
scripts/deploy-edge-agent.sh edge-agent-v6
```

Or, to deploy whatever the newest tag is without looking it up:

```bash
scripts/deploy-edge-agent.sh --latest
```

The script checks out the tag, runs `pnpm install --frozen-lockfile`, builds
`@mes/shared` and `@mes/edge-agent`, and restarts the edge-agent systemd
services that are **running** on this node (`mes-edge-node`, plus the legacy
`mes-edge-agent*` units if one is active). A unit that exists but is not
running is skipped and reported, so a deliberately disabled legacy unit is
never started by a deployment. After restarting `mes-edge-node` it waits up to
60 s for the `claimed edge node` log line and warns if it does not appear.

**Note (Oct 5):** until commit `6fe6543` the `SERVICES` list did not contain
`mes-edge-node`, and its check (`systemctl list-units | grep "^<unit>"`)
never matched because the output lines start with spaces - the script would
not have restarted the edge node. The fixed script has **not been run on
node-gate yet**; v3-v6 were deployed by hand, which remains valid:

```bash
cd ~/mes
git fetch --tags origin && git checkout edge-agent-vN
pnpm install --frozen-lockfile
pnpm --filter @mes/shared build && pnpm --filter @mes/edge-agent build
systemctl restart mes-edge-node
```

Building `@mes/shared` is needed on node-gate: its checkout had a stale
`shared` build (an unrelated backend build there failed on the `off_shift`
status). Deploy the **backend first** when a release uses a new endpoint
(v5 needs `POST /api/edge-nodes/release` and the `settings` in the claim
response; an older backend only makes the agent log a warning on shutdown and
use the environment default). v6 needs no backend change.

**A restart used to cost about a minute of data; since v5 a clean restart
does not.** The backend admits a new instance of an edge node only when the
previous heartbeat is older than `HEARTBEAT_STALE_SECONDS` (90 s). From v5 the
agent releases its session on SIGTERM, so `systemctl restart` is picked up at
once. Two cases still wait for the lease: the first start of v5 over an older
agent (it cannot release; the new process exits with `another instance of this
edge node is already active` and systemd restarts it every few seconds, the
counter climbs to ~19 — expected, once), and a crash or `kill -9`. Nothing is
collected during that wait, but the parts made meanwhile are booked afterwards
by the catch-up (below) if the gap is not longer than the limit.

## Rolling back

If a deployed version turns out to have a problem:

```bash
scripts/deploy-edge-agent.sh --rollback
```

This finds the tag immediately before the one currently deployed,
deploys it, and restarts the services — no need to remember or look up
the previous version number. (By hand: `git checkout edge-agent-v<N-1>`,
build, restart, as in the deploy note above.)

## Checking what's currently deployed

```bash
git describe --tags --match 'edge-agent-*' --exact-match
```

If this prints a tag name, that tag is exactly what's running. If it
errors, the working tree is on some untagged commit (e.g. mid-development
on `main`) rather than a released version.

## Catch-up of missed parts and per-node settings (v5)

The counter sources compare the PLC's cumulative counters with the last
values they saw. Those values are kept on disk next to the buffer
(`COUNTER_STATE_DIR`, default: the directory of `BUFFER_FILE_PATH`; file
`counters.<machineId>.json`, written atomically, at most every 5 s when
nothing changes). After a start of the agent or after a lost PLC connection
the difference is booked, **but only if the gap is not longer than
`catchupMaxMinutes`** (default 10). Event timestamps are the time of booking,
so a long gap would put the parts into the wrong hour and shift; longer gaps
are dropped and the log says how many parts were lost.

| Situation | Result |
|---|---|
| no stored values (first start) | baseline only, no burst |
| counter went backwards (PLC reset) | new baseline, nothing booked |
| difference 0 | nothing |
| gap > limit, or the clock went back | dropped, warning in the log |
| more than 5000 parts at once | dropped, warning (a wrong register is more likely than real production) |
| limit 0 | catch-up off, differences are always dropped |
| otherwise | booked |

Log lines to look for (`journalctl -u mes-edge-node | grep catch-up`):
`catch-up: parts produced while not observed are booked now` /
`... were NOT booked`.

**Per-node setting.** `catchupMaxMinutes` is stored per edge node in
`edge_nodes.settings` (migration 039; missing keys fall back to the defaults
in `edge-node-settings.ts`) and delivered in the response to `claim`, so a
change takes effect when the agent next starts. API (admin/manager, audited
as `edge_node_settings_updated`, restricted when the license is expired like
other configuration):

```bash
GET   /api/edge-nodes/:id/settings
PATCH /api/edge-nodes/:id/settings   {"catchupMaxMinutes": 15}   # integer 0..1440
```

`CATCHUP_MAX_MINUTES` in the unit is the fallback for legacy mode and older
backends. Since Oct 5 the value is edited in Admin → Edge nodes (field
"Catch-up limit (minutes)" on the node card). More per-node settings can be
added to the same JSON object and the same form.

The legacy single-machine mode uses the same catch-up with the `MACHINE_ID`
and the environment limit.

## Starting without the broker (v6)

Until v5 the registry-mode agent waited for the first MQTT `connect` before it
started the channels, so with the broker (or the network to it) down at start
the PLCs were not read at all. From v6 the channels start right after the
claim. Events go into the file buffer as always and are published when the
connection is there; the acknowledgement topic is subscribed on **every**
`connect`, not once, because a channel can now exist before the first
connection. On SIGTERM the agent forces the exit after 5 s, so a shutdown with
the broker unreachable cannot hang until systemd's timeout. The log line
`connected to broker` now appears whenever the connection is (re)established,
and not before the channels start.

## Clock of the device (v7)

Event timestamps and the catch-up age come from the device's own clock. A
wrong clock puts events in the future or the past, and because the current
status of a machine is the event with the latest timestamp, future-dated events
hide real status changes (chaos slice 9). From v7:

- the claim and every heartbeat carry the agent's clock (`clientTimeMs`); the
  backend stores `clock_offset_ms` (device minus server, migration 041) and the
  Edge nodes page shows it ("clock: in sync", "120 s ahead", "15 min behind"),
  red above 30 s;
- the claim response carries the server time (`serverTimeMs`); if the clock
  differs by more than 30 s the agent logs an `error` line with `clockAheadMs`
  and the text "The clock of this device is N s ahead of / behind the server's";
- units generated by `install-on-node.sh` start after `time-sync.target`. For a
  node installed earlier add a drop-in once (it takes effect at the next start):

      mkdir -p /etc/systemd/system/mes-edge-node.service.d
      printf '[Unit]\nAfter=time-sync.target\nWants=time-sync.target\n' \
        > /etc/systemd/system/mes-edge-node.service.d/time-sync.conf
      systemctl daemon-reload

The agent does not correct its clock or its timestamps in v7 to v12 (from v13 it
corrects its timestamps, see below); v7 only makes a wrong clock visible. The backend, which needs no agent release, adds two protections
on top: the system alert `edge_clock_skew` (online node, more than 30 s off in
either direction, resolves by itself) and an ingestion guard (an event stamped
more than 60 s in the future is stored with the receive time and keeps the
original in `payload.timestampCorrected`). From v8 the catch-up log reports a
stored state from the future as `clock_back` instead of `too_old`. An agent older than v7 sends no clock and shows "unknown" (no
clock line). **Deploy the backend first** (migration 041; it also accepts the
older agents).

## Disk of the device (v9)

The event buffer lives on the disk of the edge device and grows while the
server is unreachable; the code sets no size limit, so a full disk is the real
limit. From v9 the claim and every heartbeat carry the used and available bytes
of the file system holding `BUFFER_FILE_PATH` (a failure to read it only leaves
the figures out). The backend stores them (`disk_used_bytes`,
`disk_avail_bytes`, migration 042), the Edge nodes page shows "disk: 42% used,
8.5 GiB free" (red when low) and the system alert `edge_disk_space` opens when
an online node's disk is above 85 % used or below 2 GiB available (clears at
80 %). An older agent sends nothing and is not checked. **Deploy the backend
first** (migration 042); it also accepts the older agents.

## Client certificate of the device (v10)

An expired client certificate stops the node at its next handshake (buffered, no
loss; chaos findings 13, 16, 17), and nothing in the system watched it. From v10
the claim and every heartbeat carry the expiry of the certificate the agent loaded
(`MQTT_CLIENT_CERT`; a failure to read it only leaves the field out). The backend
stores it (`edge_nodes.client_cert_expires_at`, migration 043), the Edge nodes
page shows it and the system alert `edge_cert_expiry` opens when any node's
certificate expires within 30 days (`EDGE_CERT_WARN_DAYS`, 1 to 3650) or has
expired. The check runs at start and every 10 minutes and the alert resolves by
itself once every reported certificate is further away; a renewed certificate is
reported when the agent starts with it. An older agent sends nothing and is not
checked. **Deploy the backend first** (migration 043); it also accepts the older
agents.

## Retry pacing, batched acks and MQTT timeouts (v11)

After a long outage the agent used to republish its whole buffer every 4 s and to
rewrite the buffer file once per ack, so the backend received the same events again
and again while it was still working through them (chaos slice 12, finding 19). From
v11: `retry-tracker.ts` publishes an event again only 15 s after the last send, at
most 300 events per sweep (oldest first), and forgets what it sent on every
(re)connect; `ack-batcher.ts` collects acknowledged ids for 250 ms and
`FileEventBuffer.removeMany` removes them with one read and at most one write (no
write at all when none of them is in the file); a failing flush is logged and the
events simply stay in the buffer. Both MQTT clients also set `keepalive: 15` and
`connectTimeout: 10000` explicitly (finding 18): a silent connection loss is noticed
after about 20 s instead of 90 s and a reconnect attempt hangs for at most 10 s
instead of 30 s. A long backlog is now sent in portions of 300 per 4 s sweep
(about 75 events/s). **Deploy the backend first** (it now skips duplicates with
`ON CONFLICT DO NOTHING`, which the older agents also benefit from).

## Start without the backend (v12)

Until v12 the channel configuration existed only in the claim response, so an agent
that started while the backend or the network was unreachable crashed and restarted
every ~14 s and collected nothing (chaos finding 21). From v12 every successful claim
saves the configuration and the node settings to `claim-cache.json` (default: next to
the buffer, `CLAIM_CACHE_PATH`; written atomically with mode 0600; only a hash of the
node token is stored, so a copy from another node or after a token change is
ignored; entries older than `CLAIM_CACHE_MAX_AGE_HOURS`, default 168, are ignored,
0 = no limit). When the claim cannot reach the backend (no answer, 10 s timeout, 5xx,
408, 429) the agent logs `backend unreachable — starting channels from the cached
configuration WITHOUT a lease` and starts the channels from the cache; without a usable
cache it behaves as before. It then claims in the background after 5, 10, 20, 40 s and
then every 60 s; on success it logs `claimed edge node after an offline start — lease
adopted`, starts the heartbeat and, if the configuration changed meanwhile, restarts
the channels with the new one. An answer of 4xx (invalid token, node removed, lease
held by another instance) is never bypassed at start; if the server keeps rejecting
the background claim for 150 s the agent stops its channels and exits (the buffer
stays on disk). **A node needs one start with the backend reachable after the update**
to create the cache. No backend change, no migration.

## Timestamp correction (v13, v14)

From v13 the agent measures how far its clock is off the server's and stamps with the
corrected time, so a wrong device clock no longer corrupts the data (chaos slice 15,
findings 25 to 31). The claim and every heartbeat response carry the server time
(`serverTimeMs`); the agent computes the offset from it (a round trip over 5 s is
discarded; an offset under 2 s is ignored; a change under 0.5 s is treated as jitter).
Event timestamps, the counter baseline and the catch-up age use the corrected clock;
durations and timers do not. The heartbeat still sends the raw device time, so the
Edge nodes page, `clock_offset_ms` and the `edge_clock_skew` alert are unchanged, and the
log keeps the line "The clock of this device is N s behind the server's; event timestamps
are corrected with the measured offset. Fix the time synchronisation anyway."

The S7 Python bridge has its own clock. From v14 the agent writes the current offset to
a file (`CLOCK_OFFSET_FILE`, set automatically next to the buffer: `clock-offset`, written
atomically) and the bridge re-reads it at most once a second; a changed offset needs no
restart. The channels restart only when the configuration changes. **Deploy the backend
first** (heartbeat answer with `serverTimeMs`; an agent older than v13 ignores it). No
migration.

Limits: after a clock step the new offset is known only at the next heartbeat (at most
30 s; events in that window are off by the size of the step; the 60 s ingestion guard
still clips large future stamps); a start without the backend (v12) has no measurement and
no correction until the first successful claim. Keep NTP/chrony running anyway.

## Lost lease (v15)

Until v14 a heartbeat that the backend refused (HTTP 409: the session is not the node's current
one, another instance claimed it; 401, 404, 400: the token or session is no longer valid) was
swallowed: the agent kept running without a lease and without a log line (chaos finding 33).
From v15 the agent logs `the backend no longer accepts this node's lease … claiming again`,
keeps the channels running (events stay buffered on disk) and claims again in the background
after 5, 10, 20, 40 s and then every 60 s, as for a start without the backend (v12). A free lease
(the usual case: it expires 90 s after the last accepted heartbeat) is adopted without a restart
(`claimed edge node again after the lease was lost — lease adopted`). If the backend keeps
refusing for 150 s, another instance owns the node: the agent stops its channels and exits 1
(the buffer stays on disk; the unit restarts it, see "A rejected first claim (v16)" for the pace). A heartbeat that fails for a network reason, a 5xx, a 408 or a 429
stays transient and is retried at the next tick (now logged). No backend change, no migration.

## A rejected first claim (v16)

Until v15 a first claim that the backend rejected (409 while the lease of a crashed instance of this node is
still fresh, 401 for an invalid token, ...) ended the process at once; the unit restarted it after 2 s and the
loop repeated every ~4.5 s (13 claims a minute) for up to 90 s after a crash, or for as long as a token stayed
invalid (chaos finding 34). From v16 the agent logs `the backend rejected the claim — no channel is started;
asking again` and waits 5, 10, 20, 40, then 60 s between the attempts for up to 150 s before it exits 1; the lease
of a crashed instance is adopted at the next attempt after it expires, without a restart. An unreachable backend
still starts from the cached configuration (v12). The unit has `RestartPreventExitStatus=78`: a configuration
error (exit 78) stops the service in the `failed` state instead of restarting it every 2 s. For installs made
before v16 add the line to `/etc/systemd/system/mes-edge-node.service` (after `RestartSec=2`) and run
`systemctl daemon-reload`. No backend change.

## Dropped catch-up gaps become `data_gap` events (v17, v18)

A catch-up gap that is not booked (longer than `catchupMaxMinutes`, a clock set back, more than 5000 parts, or
catch-up switched off) used to show only in the journal of the edge node. From v17 (Modbus, OPC UA) and v18 (S7
bridge as well) the agent also sends an event of the type `data_gap`: `reason` (`too_old`, `clock_back`,
`too_large`, `disabled`), `gapSeconds` (the length of the gap; negative if the clock was set back, `null` if
unknown), `lostGood`, `lostScrap`. It travels the same buffered, acknowledged path as every other event, so it is
not lost during an outage. The backend stores it in `events` and writes a warning to its log
(`edge agent reports parts that could not be booked (data gap)`); it is no machine state, so the live state and the
dashboard feed ignore it, and the hourly rollups (which count `production_count` and `machine_status` only) are
unaffected. The timestamp is the moment the agent noticed the gap (the end of the gap).

**Deploy order: backend first, then the edge nodes.** A backend without the new type rejects the event as invalid
and does not acknowledge it, so the edge agent would resend it from its buffer forever.

List the gaps:

```
SELECT timestamp, machine_id, payload->>'reason' AS reason, payload->>'gapSeconds' AS gap_s,
       payload->>'lostGood' AS lost_good, payload->>'lostScrap' AS lost_scrap
FROM events WHERE type = 'data_gap' ORDER BY timestamp DESC;
```

Not covered: the GPIO bridge has no catch-up. No alert or dashboard view uses the event yet.

## Release notes

- **edge-agent-v18** (Oct 8, 2026, `7825e7b`) — the S7 bridge reports a dropped gap too: `dropped_gap()` in
  `python/catchup.py`, a `data_gap` line on the bridge's stdout, strict parsing in `ProcessBridgeSignalSource`.
  Tests: edge-agent 123, Python catch-up 15 (node-gate: 31 in all). Verified live: 3 minute stop with a 1 minute limit,
  S7 183 s, 47 good / 3 scrap.
- **edge-agent-v17** (Oct 8, 2026, `0682ca2`) — the new `data_gap` event type (shared schema), reported for Modbus
  and OPC UA (`CounterBaseline.takeDroppedGap()`, `droppedGapOf` in `catchup.ts`); `ProductionGate` and
  `SignalPresenceWatchdog` pass it through. **Needs a backend with the same commit** (see above). Verified live:
  3 minute stop with a 1 minute limit, Modbus 184 s, 73 good / 6 scrap, OPC UA 185 s, 81 / 9.

- **edge-agent-v16** (Oct 8, 2026, `07b55d8`) — waits out a rejected first claim with a backoff instead
  of exiting (new `initial-claim.ts`, 7 unit tests, `index.ts` first claim), `RestartPreventExitStatus=78` in
  `install-on-node.sh`. No backend change. `pnpm test`: shared 6, edge-agent 116, backend 215. Verified on
  node-gate: after a SIGKILL 1 restart (v15: 15 to 18 in 100 to 120 s), 4 refused claims at +5, +10, +20 s,
  claimed after 75 s without a restart. Note: the deploy on node-gate is the checkout of the tag
  (detached HEAD), so `git pull` fails there; use `scripts/deploy-edge-agent.sh edge-agent-v16`.

- **edge-agent-v15** (Oct 8, 2026, `37f1f51`) — claims again when the heartbeat shows the lease
  was lost, stops after 150 s of refusal (new `heartbeat-failure.ts`, 14 unit tests;
  `sendHeartbeat` throws `HeartbeatHttpError`, `startLeaseClaim` in `index.ts` shared with the
  offline start). No backend change. Deployed on node-gate with
  `scripts/deploy-edge-agent.sh edge-agent-v15` after checking out the tag; the node claimed at
  once. Verified: lease replaced once -> adopted after 89 s without a restart; lease held by a
  simulated live instance -> stop after about 186 s, claim 3 s after the foreign lease expired.

- **edge-agent-v14** (Oct 8, 2026) — live clock correction without a channel restart:
  `clock-offset-file.ts`, `python/clock_offset.py` (6 tests), `CorrectedClock` simplified
  (no restart on a change), listeners of `setupChannel` removed in `stop()`, ack batcher
  flushed on stop; changes in `index.ts`, `config.ts`, `s7_bridge.py`. No backend change
  since v13. Verified on node-gate: offset file 300053, then 270004 after a clock step, then
  0 after the restore; 0 matches for `restarting channels`, `clock_back`,
  `MaxListenersExceededWarning`; stamps within 0 s of the arrival, 20 events 30 s ahead in the
  detection window after the step. `pnpm test`: shared 6, edge-agent 95, backend 194.
- **edge-agent-v13** (Oct 8, 2026, `2f64596`) — timestamps corrected with the server time
  (new `corrected-clock.ts`), `serverTimeMs` in the claim and heartbeat responses
  (backend `server.ts`). **Deploy the backend first.** Superseded by v14 because a change
  of the correction during the run restarted the channels (dropped parts) and leaked
  listeners; do not stay on v13.

- **edge-agent-v12** (Oct 8, 2026) — start from the cached channel configuration when
  the backend is unreachable, background claim with lease adoption (new
  `claim-cache.ts`, `offline-claim.ts`, 24 unit tests; changes in `index.ts` and
  `config.ts`). No backend change. Deployed on node-gate with
  `scripts/deploy-edge-agent.sh edge-agent-v12` after checking out the tag; the node
  claimed at once and `claim-cache.json` appeared. Verified with a restart during a
  4 minute packet-drop partition: channels running 10 s after the restart, buffers 0,
  no duplicates, longest gap 24 s, lease adopted 27 s after the heal. (The tag was first
  pushed by mistake before the commit and replaced by the correct one before any
  deployment.)

- **edge-agent-v11** (Oct 7, 2026) — paced and bounded retry sweeps (new
  `retry-tracker.ts`), batched ack removal (new `ack-batcher.ts`,
  `FileEventBuffer.removeMany`), explicit MQTT keepalive 15 s and connect timeout
  10 s on both clients, changes in `index.ts` (legacy and channel mode) and
  `buffer.ts`; backend `events-repository.ts` uses `INSERT ... ON CONFLICT DO
  NOTHING`. **Deploy the backend first.** Deployed on node-gate with
  `scripts/deploy-edge-agent.sh edge-agent-v11` after checking out the tag; the
  node claimed at once. Verified with the same 4 minute packet-drop partition as
  before: 0 duplicate-key errors (was about 2000), 1 s of CPU peak (was 30 s), no
  request over 1 s (was 10 to 35 s), detection after 21 s (was 90 s), buffers 0, no
  data lost.
- **edge-agent-v10** (Oct 7, 2026) — the agent reports the expiry of its client
  certificate with the claim and every heartbeat (new
  `packages/edge-agent/src/client-cert.ts`, unit-tested, and the claim/heartbeat
  calls in `index.ts`). **Deploy the backend first** (migration 043, new alert,
  Edge nodes page). Deployed on node-gate (`~/mes`) with
  `scripts/deploy-edge-agent.sh edge-agent-v10` after checking out the tag; the
  agent claimed at once and the database showed `2027-10-02 07:54:40+02` for
  `node-gate-sim`. Live alert check with `EDGE_CERT_WARN_DAYS=400` as a
  temporary drop-in on node-dc, removed afterwards.
- **edge-agent-v9** (Oct 6, 2026) — the agent reports the disk usage of its
  buffer directory with the claim and every heartbeat (new
  `packages/edge-agent/src/disk-usage.ts`, unit-tested, and two lines in
  `index.ts`). **Deploy the backend first** (migration 042, new alert, Edge
  nodes page). Deployed on node-gate with `scripts/deploy-edge-agent.sh
  edge-agent-v9` after checking out the tag; the agent claimed at once and the
  database showed 6365 MB used / 8755 MB available for `node-gate-sim`.
- **edge-agent-v8** (Oct 5, 2026) — catch-up: a stored counter state from the
  future (the clock was set back, negative age) is reported with the reason
  `clock_back` instead of `too_old`; the parts are still not booked. Change in
  `catchup.ts`, the log switch in `counter-baseline.ts` and the Python mirror
  `python/catchup.py` (unit tests updated in both). No backend change, no
  migration. Deployed on node-gate with `scripts/deploy-edge-agent.sh
  edge-agent-v8` after checking out the tag (it printed "currently:
  edge-agent-v8" because of that, which is harmless); the agent claimed at once
  and the Python tests ran 18 OK there.
- **edge-agent-v7** (Oct 5, 2026) — the agent sends its clock with the claim and
  every heartbeat, compares it with the server time returned by the claim and
  logs a clock skew above 30 s (chaos finding 8); backend and Edge nodes page
  show the offset; the onboarding unit waits for the time sync. New files
  `packages/edge-agent/src/clock-check.ts` (unit-tested) and a few lines in
  `index.ts`. **Deploy the backend first** (migration 041). Deployed on node-gate
  with `scripts/deploy-edge-agent.sh edge-agent-v7` — the first real run of the
  fixed script (it must be started from the new tag: the checkout of v6 still
  had the old script, so check out the new tag first and then run it; the run
  itself finished in seconds, restarted `mes-edge-node` and waited for the
  claim). Tested live with the agent clock shifted by +2 min (libfaketime): the
  agent logged `clockAheadMs: 119950`, the database held 119874 ms, the page
  showed "clock: 120 s ahead" in red; after the restore the offset was −7 ms and
  the page showed "in sync".
- **edge-agent-v6** (Oct 5, 2026) — channels start without waiting for the MQTT
  broker (chaos finding 5), acks are re-subscribed on every connect, shutdown
  is forced after 5 s. Change only in `packages/edge-agent/src/index.ts`; no
  backend change, no new unit test (the entry point cannot be imported in a
  test), verified live. Tested on node-gate: with the broker stopped, a clean
  restart started all three channels at once and buffered 13 / 12 / 7 events;
  after the broker was started the buffers emptied and the database matched
  the PLC counter difference exactly (55 / 5, 53 / 2, 28 / 1).
- **edge-agent-v5** (Oct 5, 2026) — parts produced while the agent was not
  running, or could not reach the PLC, are booked afterwards (S7, Modbus and
  OPC-UA), for gaps up to the per-node limit `catchupMaxMinutes` (default 10).
  On SIGTERM the agent releases its instance lease
  (`POST /api/edge-nodes/release`), so a clean restart no longer leaves a ~70 s
  gap. The onboarding script now generates units with `StateDirectory=mes-edge`
  and `BUFFER_FILE_PATH=/var/lib/mes-edge/buffer.ndjson`. **Deploy the backend
  first** (migration 039, release endpoint, settings API). The first start over
  v4 shows the `already active` loop for ~90 s once. Tested on node-gate: a
  60 s stop booked 14 / 31+1 / 21+5 parts, matching the database.
- **edge-agent-v4** (Oct 2, 2026) — **breaking:** without `EDGE_NODE_TOKEN` the
  agent no longer starts in legacy mode; it logs why and exits with code 78.
  The old single-machine mode must be requested with `EDGE_AGENT_LEGACY=true`.
  Reason: a forgotten token used to make a node publish events for the default
  machine id `sim-machine-01`. Check before deploying: every unit that should
  keep running has a token (`/etc/mes/edge-node.env`) or the legacy flag. Units
  that are disabled "legacy" leftovers now fail on a stray restart instead of
  publishing, which also makes `deploy-edge-agent.sh` safe against them.

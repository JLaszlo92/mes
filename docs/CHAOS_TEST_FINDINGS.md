# Chaos Testing Findings — M8

**Date:** September 21, 2026 (slice 1), October 5, 2026 (slices 2 to 9), October 6, 2026 (slice 10), October 6 to 7, 2026 (slice 11)
**Scope:** Slice 1: outage testing of the four signal sources (GPIO, S7, OPC-UA, Modbus), per ROADMAP M8 ("offline-resilience chaos testing"). Slice 2: outages of the transport and of the edge agent itself. Slice 3: re-test of the edge agent after `edge-agent-v5` (catch-up, lease release, `kill -9` with a non-empty buffer). Slice 4: `edge-agent-v6` — start of the agent while the broker is down. Slice 5: reboot of the edge node (node-gate) with the broker down and a non-empty buffer. Slice 6: hard stop of the edge node container. Slice 7: a gap longer than the standard 10 minute catch-up limit. Slice 8: stopping the agent while the broker is down. Slice 9: clock skew of the edge node (+15 minutes). Slice 10: Postgres stopped on node-dc. Slice 11: expired broker certificate.

## Method

For each signal source, the underlying process/server was killed entirely
(`systemctl stop` on the simulator or PLC-facing service — not just a
network blip), while watching whether the dashboard correctly showed the
machine as `down` during the outage, and recovered automatically once the
service was restarted.

## Findings

| Source | Before | Root cause | Fix |
|---|---|---|---|
| **GPIO** | ✅ Always correct | Pull-down wiring reads a broken/disconnected line as `down` at the hardware level — no software logic needed. | None needed. |
| **S7** | ❌ Froze on last known status | `s7_bridge.py`'s own reconnect loop caught connection errors and retried silently, without ever emitting a `down` status line. | Emit `{"kind":"machine_status","status":"down"}` once per outage, before the retry loop; re-announce the real status explicitly on reconnect. |
| **Modbus** | ❌ Froze on last known status | `ModbusSignalSource.ts` had no reconnection logic at all — a failed poll just logged and gave up. | Added reconnect-on-failure logic, plus an explicit synthetic `down` emission on the first failed poll of an outage. |
| **OPC-UA** | ❌ Froze on last known status, plus a growing backlog of unresolved requests | `node-opcua`'s `session.read()` doesn't reject when the connection drops — it queues the request indefinitely while node-opcua reconnects in the background. Combined with our `setInterval` firing regardless, this piled up pending `ReadRequest`s (node-opcua's own "sending multiple requests simultaneously" warning). | Added a `pollInFlight` guard (never start a new read while one is outstanding) and a 3-second timeout on the read, treating a stuck read as a failure that surfaces a `down` status. |

## Verification

Each fix was confirmed by killing the corresponding simulator process
entirely and observing, on the live dashboard, that the machine's status
switched to `down` within a few seconds of the outage starting, and back
to its real status within a few seconds of the service being restarted —
with no manual intervention (no edge-agent restart needed) in any case.

## Remaining known gaps (slice 1, not addressed)

- The GPIO/S7 shared `ProcessBridgeSignalSource` now respawns a crashed
  bridge process after a fixed 5-second delay, indefinitely — there is no
  backoff (e.g. exponential) if the underlying problem is persistent. For
  a short-lived pilot this is acceptable; worth revisiting if a bridge
  process crash-loops for an extended period in production.
- None of the four sources currently retry a *specific* failed read — on
  a timeout or error, the next attempt starts fresh rather than replaying
  exactly what was missed. Given the poll-and-diff model (a counter is
  re-read fully next time, not incrementally), this is not a data-loss
  risk, just worth noting as a design property. *(Updated Oct 5: for a
  lost PLC connection or a restarted agent this is no longer true as such —
  since `edge-agent-v5` the counters are compared with the last stored
  values and the gap is booked up to a limit; see slice 3.)*

## Slice 2 — transport, backend and edge agent outages (Oct 5, 2026)

Run on the pilot infrastructure (node-dc, node-gate, node-sim) with three
simulated machines producing about 0.5 events/s each.

**Method.** Every event is appended to the edge agent's file buffer before
it is published and removed only when the backend's application-level ack
arrives. So the buffer is the exact list of unacknowledged events:
`ops/chaos/buf-snap.sh` (edge node) prints its size and time span per
machine; `ops/chaos/chaos-svc.sh` (node-dc) stops a service for N seconds.
After the service is back, the database must contain exactly the buffered
events (same machine, `timestamp` within the buffered span), the buffer must
be empty, and no unexplained gap may appear in the event timeline.

| Test | Outage | Result |
|---|---|---|
| Mosquitto stopped | 41 s (the 2 min plan was cut short by a typing slip) | Buffered 5 / 6 / 6 events; 5 / 6 / 6 in the database; buffer empty; no gap |
| Mosquitto stopped | 10 min 32 s | Buffered 290 / 300 / 199; all in the database exactly once; whole replay in 0.5 s, 4 s after the broker came back |
| Backend stopped | 2 min | Buffered 54 / 63 / 33; all in the database; replay started 5 s after the backend and took 0.3 s |
| Edge agent `kill -9` | not applicable | systemd restarted it by itself; no orphaned `s7_bridge.py`; **70 s without data on every machine**; no burst of counts after the restart |

Duplicate protection: the unique index on `(source_event_id, timestamp)`
plus the 4-second republish of unacked events gave no duplicates in any
test. The long-outage replay (300 events per machine) showed no slowdown
from the rewrite-the-file-on-every-ack design of `FileEventBuffer.remove()`.
The large gaps seen in the timeline during the tests were real machine
stops (a `down` status event at the start, `running` at the end), not
missing events.

### Findings

1. **The buffer lived in `/tmp`, which is a tmpfs on node-gate** — a reboot
   would have lost every unacknowledged event. Fixed on node-gate with a
   systemd drop-in (`mes-edge-node.service.d/buffer.conf`:
   `StateDirectory=mes-edge`, `BUFFER_FILE_PATH=/var/lib/mes-edge/buffer.ndjson`).
   Since `edge-agent-v5` `ops/onboarding/install-on-node.sh` generates the same
   settings for new nodes. The buffer is appended without `fsync`, so a power
   cut can still lose the last second or two. *(Confirmed for a clean reboot in slice 5.)*
2. **Every edge agent restart cost about 70 s of data** (`kill -9`, crash,
   deployment). The backend admits a new instance only when the previous
   heartbeat is older than `HEARTBEAT_STALE_SECONDS`, and the agent did not
   release its session on shutdown. **Fixed for clean restarts in v5** (the
   agent releases the session on SIGTERM, see slice 3); after a crash or
   `kill -9` the new instance still waits for the lease.
3. **Parts produced while the agent process is down were not counted.** All
   three counter sources took the first reading after a start as the
   baseline (`first_poll` in `s7_bridge.py`, `lastGoodCount = null` in the
   Modbus and OPC-UA sources) — which is also why a restart does not
   double-count. *Correction (Oct 5):* the first version of this document
   said a PLC connection loss inside a running process is caught up
   afterwards. That is true for Modbus and OPC-UA (the previous value is
   kept) but **not for S7**: after a recovery `s7_bridge.py` only re-announces
   the status and skips the counter diff. Fixed in v5 for all three sources:
   the last counter values are persisted next to the buffer and compared on
   start and after a lost connection, with a sanity rule for counters that
   went backwards (PLC reset) and a limit on the age of the gap (event
   timestamps are the time of emission, not of production).
4. `gpio-` and `s7-signal-source` tests had been failing since `58b141c`
   (custom status names are valid, a bridge that exits reports `down`);
   assertions updated on Oct 5. They still wait a fixed 400 ms, so they can
   fail on a loaded machine.

## Slice 3 — edge-agent-v5 re-test (Oct 5, 2026)

Deployed to node-gate by hand (`edge-agent-v5`, backend with migration 039
first). Machines: `s7-rig-01`, `modbus-rig-01`, `opcua-rig-01`.

| Test | Result |
|---|---|
| First start of v5 | The old agent had not released its lease, so the new process looped on `another instance ... already active` for about 90 s (19 restarts, expected once) and then claimed the node; the log showed `catchupMaxMinutes: 10` and, per channel, `no earlier counter values known; starting from the current ones` |
| Clean `systemctl restart` | New instance claimed the node 2 s after the stop, no `already active` loop (the ~70 s gap is gone for clean restarts) |
| Restart, 4–7 s gap | Parts made during the restart were booked: 2 / 2 / 1 |
| Agent stopped for 60 s, then started (gap 64 s) | Booked after the start: S7 14 good, Modbus 31 good + 1 scrap, OPC-UA 21 good + 5 scrap. Database window around the start: S7 15 / 0, Modbus 32 / 1, OPC-UA 22 / 5 — the catch-up numbers plus one live part per machine |
| Per-node limit set to 1 minute (`edge_nodes.settings`, changed in the database), agent stopped for 2 min | The agent used the new limit after the restart and dropped the gap (`too_old`, gap 123–125 s), logging exactly what was lost: S7 26 good / 2 scrap, Modbus 54 / 2, OPC-UA 53 / 7. Limit set back to 10 and the agent restarted afterwards |
| **Broker stopped, then agent `kill -9` 73 s later, broker started again 3 min after the stop** | Buffer at the kill: 37 / 38 / 21 events (all of them still in the file after the kill). The new instance waited for the lease (18 restarts, ~96 s), claimed the node, and then waited for the broker. After the broker returned: buffers empty, **0 duplicates**, catch-up booked the part of the gap in which nobody observed the PLC (S7 35 good / 4 scrap, Modbus 48 / 3, OPC-UA 42 / 2; gap 101–102 s). Per machine, the good/scrap events in the database between the first and the last counter sample equal the PLC counter difference: Modbus 93 / 6 = 93 / 6, OPC-UA 83 / 5 = 83 / 5, S7 56 / 6 vs 55 / 6 (one live part at the window edge) — no loss, no duplication |

The state files in `/var/lib/mes-edge/` (`counters.<machine>.json`) held the
last counter values and the time they were seen.

**Rule.** A gap is booked only if it is not longer than `catchupMaxMinutes`
(default 10, per edge node, `edge_nodes.settings`; `CATCHUP_MAX_MINUTES` is the
fallback). Longer gaps are dropped with a warning that names the number of
lost parts, because the events would be stamped with the time of booking and
land in the wrong hour and shift. A counter that went backwards starts a new
baseline; more than 5000 parts in one catch-up is treated as a wrong register
and dropped. The same rule applies to a lost PLC connection while the agent
runs.

### Findings

5. **An agent that starts while the broker is down does not read the PLC at
   all until the broker is back.** `runRegistryMode` waited for the MQTT
   `connect` before it started the channels. The catch-up made this harmless
   up to `catchupMaxMinutes`, but if the broker (or the network to it) was
   down longer than the limit at the moment the agent started, the parts of
   that period were dropped even though the PLC kept counting. **Fixed in
   `edge-agent-v6`** (see slice 4).
6. The lease wait after a crash is the same ~90 s as before; only a clean
   shutdown releases the lease. A shorter `HEARTBEAT_STALE_SECONDS` would
   shorten it at the cost of false duplicate-session errors on a slow
   network.
7. Test-method note: a database comparison needs a lower **and** an upper
   time bound per machine, taken from the `seenAtMs` of the counter files
   before and after the test. A first query without an upper bound showed
   too many parts (the machines kept producing).

## Slice 4 — edge-agent-v6: start with the broker down (Oct 5, 2026)

Change (`packages/edge-agent/src/index.ts` only): the channels start right after
the claim, without waiting for the MQTT `connect`; the ack topic is subscribed
on every `connect`; SIGTERM forces the exit after 5 s. There is no unit test for
it (the entry point starts the agent on import), so the live test is the
evidence.

| Step | Result |
|---|---|
| Mosquitto stopped on node-dc (16:34:54 UTC), agent restarted cleanly on node-gate (16:35:05) | Claimed the node immediately (no lease wait), then `channel started` for all three machines within 0.2 s — with the broker down. No `connected to broker` line while it was down |
| Catch-up at the start | Modbus 2 good / 1 scrap (gap 5 s), OPC-UA 1 / 0 (gap 6 s) booked into the buffer |
| 15 s into the outage | Buffers held 13 / 12 / 7 events (they also contain the events of the previous agent from the first seconds of the outage) |
| Mosquitto started again | Buffers 0 / 0 / 0; acks work after the late connection (the subscription is repeated on every `connect`) |
| Database vs PLC counters, per-machine window from the counter files before and after the test (two time bounds, see finding 7) | Modbus 55 good / 5 scrap, OPC-UA 53 / 2, S7 28 / 1 in the database; the PLC counter differences are 55 / 5, 53 / 2, 28 / 1 — **exact match, no loss, no duplication** |

Effect: the length of a broker outage at the moment of an agent start no longer
decides whether parts are lost; the disk buffer takes them, and the
`catchupMaxMinutes` limit only applies to gaps in which nobody read the PLC.

## Slice 5 — node-gate reboot with the broker down (Oct 5, 2026)

Question: do the buffer and the counter state files in `/var/lib/mes-edge`
survive a reboot of the edge node, and does the agent come back without
manual action while the broker is still unreachable? Agent: `edge-agent-v6`.
node-gate is a Proxmox LXC container, so this is a container reboot (software
restart, host disk untouched), not a power cut.

**Procedure.** `mes-edge-node` is `enabled`. Mosquitto stopped on node-dc at
17:32:13 UTC; after about 60 s, with the buffers filling, `sync; reboot` on
node-gate at 17:33:16. After the boot the broker was kept down for another
minute, then started.

| Step | Result |
|---|---|
| Before the reboot (broker down 63 s) | Buffers 31 / 31 / 21 events (modbus / opcua / s7), oldest at 17:32:15 / 17:32:15 / 17:32:14. Counter files: good/scrap Modbus 53960 / 16058, OPC-UA 183399 / 15719, S7 108346 / 9289 |
| Boot | Container up in a few seconds; `mes-edge-node` active by itself. `claimed edge node` 7 s after the `reboot` command — **no `already active` wait**, i.e. the SIGTERM during shutdown released the lease. Three `channel started` lines within 0.3 s, with the broker still down; no `connected to broker` line |
| Catch-up (gap about 10 s) | Modbus 3 good / 1 scrap, OPC-UA 5 / 0 booked from the counter files that were read from disk. No catch-up line for S7 (no parts produced in the gap) |
| 70 s after the boot, broker still down | Buffers 72 / 69 / 40 events; the **oldest events are the same as before the reboot** (17:32:15.220 / 17:32:15.220 / 17:32:14.846), so the pre-reboot content survived and the new events were appended to it |
| Broker started | Buffers 0 / 0 / 0 within seconds; stays empty |
| Database vs PLC counters (per-machine window from `seenAtMs` before and after, two bounds) | Counter differences Modbus 85 good / 6 scrap, OPC-UA 81 / 4, S7 43 / 4; the database holds **85 / 6, 81 / 4, 43 / 4 — exact match, no loss, no duplication** |

Conclusion: a clean reboot of the edge node with a non-empty buffer and a dead
broker costs no data. Buffer and counter state are on persistent storage, the
service starts by itself, the lease is released on shutdown, the channels read
the PLCs without the broker, and the catch-up books the few seconds of the
reboot. No new defect found.

Limits of this test: it is a clean shutdown of a container. The hard stop is
slice 6.

## Slice 6 — hard stop of the edge node container (Oct 5, 2026)

Question: what happens when the edge node dies without any shutdown (no
SIGTERM, so no lease release), with the broker down and a non-empty buffer?
`pct stop 101` on the Proxmox host (immediate stop, equivalent to a crash of
the container), started again 10 s later. Agent: `edge-agent-v6`.

**Limit of the method.** The container's files live on the host's disk and
page cache, and the host keeps running. So this test cannot reproduce the loss
of data that was appended without `fsync` in a real power cut (finding 1); it
covers the lease wait, a half-written last buffer line and the catch-up after a
hard stop. A host power cut was deliberately not tried (it would hit the other
containers).

**Procedure.** Mosquitto stopped on node-dc at 17:42:15 UTC; buffers read at
17:43:18 (31 / 31 / 13 events); no `sync`; `pct stop` at 17:43:46, container
started at 17:43:56.

| Step | Result |
|---|---|
| Right after the boot (17:44:35) | Buffer files 45 / 45 / 17 lines, **0 invalid lines** (every line parsed as JSON, including the last one); the oldest events are the ones from before the stop |
| Lease | The service looped 12 times on `another instance ... already active` and **claimed the node at 17:44:57**, about 71 s after the stop (the old instance had not released its lease; expected, finding 6) |
| Channels | All three started within 0.2 s of the claim, with the broker still down |
| Catch-up (gap 71–73 s, within the 10 minute limit) | S7 22 good / 2 scrap, Modbus 35 / 1, OPC-UA 33 / 4 booked |
| Buffers while the broker was down | 131 / 132 / 69 events at 17:46:35; oldest events unchanged |
| Broker started | Buffers 0 / 0 / 0 within seconds |
| Database vs PLC counters (per-machine window from `seenAtMs` before and after, two bounds) | Counter differences Modbus 113 good / 8 scrap, OPC-UA 115 / 7, S7 62 / 6; the database holds **113 / 8, 115 / 7, 62 / 6 — exact match, no loss, no duplication** |

Conclusion: a hard stop of the edge node with a non-empty buffer and a dead
broker costs no data, only the ~70 to 90 s lease wait during which the PLC is
not read by anyone; the catch-up books that period afterwards (as long as it
is shorter than `catchupMaxMinutes`). No half-written last line was found.
The remaining uncertainty is the real power cut (unsynced appends) which needs
a host-level or hardware test.

## Slice 7 — gap longer than the 10 minute catch-up limit (Oct 5, 2026)

Question: with the standard limit (`catchupMaxMinutes` = 10, shown in the claim
log line), is a gap longer than the limit dropped, are the lost parts reported
exactly, and are they really absent from the database? Slice 3 had tested this
only with the limit set to 1 minute. Broker and backend were up.

**Procedure.** Counters read at 17:54:23 UTC; `systemctl stop mes-edge-node`
at 17:54:31 (clean stop, lease released); start scheduled with
`systemd-run --on-active=665`. The agent claimed the node at 18:06:05 (the
timer fires up to a minute late by default, `AccuracySec`), gap 696–698 s.

| Machine | Log line at the start | PLC counter difference (whole window) | Database (same window) |
|---|---|---|---|
| Modbus | `NOT booked`, `reason: too_old`, `ageSeconds` 696, `lostGood` 287, `lostScrap` 31 | 302 good / 33 scrap | 15 / 2 |
| OPC-UA | `NOT booked`, `too_old`, 698 s, lost 305 / 23 | 317 / 29 | 12 / 6 |
| S7 | `catch-up: 155 good / 16 scrap ... were NOT booked (too_old, gap 697s)` | 160 / 16 | 5 / 0 |

Counter difference minus the parts named as lost equals the database exactly
for every machine and both result types (302 − 287 = 15, 33 − 31 = 2,
317 − 305 = 12, 29 − 23 = 6, 160 − 155 = 5, 16 − 16 = 0): the dropped gap is
not in the database, the parts before the stop and after the start (the live
ones) are, and nothing was booked twice. The log level of the Node channels is
40 (warning), so the loss is visible in the journal.

Conclusion: the limit works as documented. For an agent outage longer than 10
minutes the loss is not silent, but it is real: the lost part counts exist only
in the journal of the edge node. A visible record in the dashboard (an event or
an alert for a dropped gap) would make it auditable.

Observations:

- The Admin → Edge nodes page showed a red dot while the agent was stopped
  (as intended) and the text `node-gate-sim last seen: never`, although the
  node had been seen minutes earlier. Cause (checked in the code):
  `releaseSession` clears `last_heartbeat_at` on a clean stop so that the node
  turns offline at once and the next start does not wait for the lease, and the
  page took its "last seen" from that column. **Fixed in `8bdc397`:** new column
  `edge_nodes.last_seen_at` (migration 040), set by claim, heartbeat and
  release; the page shows it, while the online state and the lease still use
  `last_heartbeat_at`. Live check: after `systemctl stop mes-edge-node`,
  `last_heartbeat_at` is empty, `has_session` is false and `last_seen_at` holds
  the stop time; the page shows that time next to the red dot.
- The `edge_nodes` table has only this one node (`node-gate-sim`).

## Slice 8 — `systemctl stop` with the broker down (Oct 5, 2026)

Question: does stopping the agent hang when the MQTT connection cannot be
closed cleanly? v6 forces the exit 5 s after SIGTERM; without that, systemd
would wait for its default 90 s `TimeoutStopSec`. Mosquitto stopped on node-dc
(the agent logged `ECONNREFUSED 192.168.60.141:8884` and reconnect attempts every
2 s), then `time systemctl stop mes-edge-node` on node-gate.

| Step | Result |
|---|---|
| `time systemctl stop` | **real 0.018 s**. Journal: `Stopping` and `shutting down…` in the same second, the S7 bridge got SIGTERM, `Deactivated successfully` |
| Exit state | `systemctl is-failed` prints `inactive` (a clean stop, not `failed`) |
| Lease | The release reached the backend although the broker was down (it goes over HTTP): `last_heartbeat_at` empty, `has_session` false, `last_seen_at` = stop time (20:26:28) |
| Start 74 s later (broker still down) | `claimed edge node` at once, no `already active`, three `channel started` lines |
| Catch-up (gap 75–77 s) | S7 12 good / 1 scrap, Modbus 29 / 4, OPC-UA 38 / 0 booked |
| Broker started again | Buffers 0 / 0 / 0 |

Conclusion: with a refused connection the stop is immediate; the 5 s forced
exit was not even needed. It stays untested for a connection that hangs instead
of being refused (packets dropped, a real network partition), where closing the
MQTT client could block.

## Slice 9 — clock skew of the edge node (Oct 5, 2026)

Question: the events carry the timestamp of the edge node's clock, and the
catch-up compares the stored `seenAtMs` with the edge clock. What happens when
that clock is wrong?

**Method.** node-gate is an LXC container and cannot set its system clock, so
only the clock of the agent process was shifted: `libfaketime`
(`LD_PRELOAD=.../libfaketime.so.1`, `FAKETIME=+15m`, `DONT_FAKE_MONOTONIC=1`)
in a temporary systemd drop-in `faketime.conf` (removed afterwards). The agent
ran with the clock 15 minutes ahead from 18:31:55 UTC (restart) to 18:34:36
(restart without the drop-in). The broker and the backend were up.

| Observation | Result |
|---|---|
| Ingestion | The backend **accepted and stored** events stamped up to 14 min 59 s in the future (`max(timestamp) - now()` = 00:14:59.5). No rejection, no log line, no warning anywhere |
| Catch-up at the start with the +15 min clock | Gap seen as 903–905 s although the real gap was a few seconds: `NOT booked (too_old)`, lost S7 1 / 0, Modbus 1 / 0, OPC-UA 2 / 0. A clock that steps forward after a restart makes the catch-up drop a gap that would have been booked |
| Dashboard during the skew | The machines' "last seen" showed 20:49 while the real time was 20:34 |
| Restoring the real clock (restart) | The stored state was now 15 minutes in the future: gap −896 s, `NOT booked (too_old, gap -896s)`, lost S7 1 / 0, Modbus 2 / 0, OPC-UA 2 / 0. No negative or wrong booking (the "state from the future" rule works), but the reason label `too_old` for a negative age is misleading |
| Current status from the latest timestamp | `state.ts`, the shift summary, the downtime evaluator, the status timeline and the status rollup choose the current status with `ORDER BY "timestamp" DESC LIMIT 1`. After the restore the OPC-UA rig had 9 future-dated status events (latest `running`, 20:49:08, real time 20:39). The real `down` periods at 20:38:38–20:38:44 and 20:39:28–20:39:34 are older than that `running`, so a view built on the latest timestamp does not show them until real time catches up with the fake events. The overview page was in sync with the system time at that moment (user observation): it apparently takes its "last seen" from another source (not checked which) |
| Mixed streams | When real time reaches the fake timestamps (20:47 to 20:49) the timeline of that period holds two streams of events (the test data stays in the database; it belongs to the pilot test-data cleanup) |

### Findings

8. **A wrong edge clock is not noticed by anything.** The backend accepts
   timestamps from the future, the heartbeat does not carry the agent's time,
   the Edge nodes page shows no skew, no alert exists.
9. **A clock ahead of the server hides real status changes** wherever the
   current status is "the event with the latest timestamp" (five places, see
   above), for as long as the skew lasts and until real time passes the
   future-dated events. A clock behind the server does the symmetric damage
   (new events are older than the existing ones; not tested).
10. **A clock step in either direction makes the catch-up drop its gap**
    (forward: the gap looks too old; backward: the stored state is in the
    future). Nothing is booked wrongly, but the parts of the gap are lost and
    the log reason is misleading for the backward case.
11. Realistic causes on edge hardware: a device without a real-time clock
    that boots before NTP is synchronised (Raspberry Pi), a dead RTC battery, a
    time sync that steps the clock while the agent runs, a wrong time zone
    setting is not a cause (timestamps are UTC).

Proposed fixes, cheapest first (status: 1 and the first half of 2 done in
`edge-agent-v7` / `b4f5f21`, see below; the rest is open):

1. Start the agent only after time sync: `After=time-sync.target` and
   `Wants=time-sync.target` in the unit generated by `install-on-node.sh`.
2. Detection: the heartbeat carries the agent's clock; the backend stores the
   offset in `edge_nodes`, shows it on the Edge nodes page and raises an alert
   above a limit (for example 30 s), like the existing certificate and backup
   health evaluators.
3. Ingestion guard: an event stamped more than about 60 s in the future gets
   the receive time as its timestamp and is marked.
4. Stronger, later: the claim and heartbeat responses carry the server time and
   the agent corrects its own timestamps (and the catch-up age) with the
   measured offset, so a wrong edge clock no longer corrupts the data.
5. Log reason `clock_back` (or similar) instead of `too_old` for a negative
   gap.

### Detection implemented and verified (edge-agent-v7, Oct 5, 2026)

Fix 1 and the detection half of fix 2: the agent sends its clock with the claim
and the heartbeat, the backend stores `edge_nodes.clock_offset_ms`
(migration 041), the Edge nodes page shows it, the agent logs a skew above 30 s
itself, and the onboarding unit waits for `time-sync.target`. The alert (fix 2,
second half), the ingestion guard (3) and the log reason (5) followed the same
evening, see the next section. Not done: the timestamp correction in the agent
(4).

Live check on node-gate with the agent clock shifted by +2 min (libfaketime,
drop-in `faketime.conf`, removed afterwards):

| Step | Result |
|---|---|
| Start with the shifted clock | Agent log (level `error`): `clockAheadMs: 119950`, "The clock of this device is 120 s ahead of the server's. Event timestamps will be wrong; check the time synchronisation (NTP, chrony or systemd-timesyncd)" |
| Database | `clock_offset_ms` = 119874 (the difference to 120000 is the network delay) |
| Edge nodes page | "clock: 120 s ahead", red and bold |
| Restore (restart without the shift) | No warning; catch-up dropped the gap as expected for a stored state from the future (`gap -117s`, lost 2 good on two machines); `clock_offset_ms` = −7; page shows "clock: in sync" |

The same check also exercised the first real run of `deploy-edge-agent.sh`
(deployment of `edge-agent-v7` on node-gate), see `EDGE_AGENT_RELEASES.md`.

### Alert, ingestion guard and log reason (Oct 5, 2026)

Fixes 2 (alert), 3 and 5 of the list above. Backend commits `36d89da` (alert)
and `689caaa` (guard); agent `d2d6c27` (log reason, tag `edge-agent-v8`).

**Alert `edge_clock_skew`** (`edge-clock-health.ts`, `edge-clock-health-evaluator.ts`,
checked every 60 s). One system alert while an *online* node's clock differs
from the server's by more than 30 s, in either direction; the message names the
nodes (worst first, at most 5) with the offset. An offline node and an unknown
offset (agent older than v7) are ignored. It resolves by itself when every
online node is within the limit.

**Ingestion guard** (`event-timestamp-guard.ts`, used by `insertEvent`). An event
stamped more than 60 s after the server's receive time is stored with the
receive time (column and payload); the original stays in
`payload.timestampCorrected` (`originalTimestamp`, `aheadMs`, `reason: "future"`)
and the backend logs a warning. Events from the past are not touched.

**Log reason `clock_back`** (`catchup.ts` and the Python mirror
`python/catchup.py`): a stored state from the future (negative age) is reported
as `clock_back`, no longer as `too_old`. The parts are still not booked.

Live check on node-gate with the agent clock shifted by +2 min (libfaketime,
drop-in removed afterwards):

| Check | Result |
|---|---|
| Alert | On the Alerts page within a minute: "edge clock skew — The clock of 1 edge node differs from the server's by more than 30 s: node-gate-sim (120 s ahead)…"; the Edge nodes page showed "clock: 120 s ahead"; the alert resolved after the restore |
| Guard | All three machines, `production_count` and `machine_status` events: `timestamp` = receive time (21:23:57), `timestampCorrected.aheadMs` 119 979 – 119 999, original +2 min kept; backend warnings "event timestamp is in the future — stored with the receive time" |
| `clock_back` | Unit tests only (TS and Python); not provoked live |

The test left about two minutes of events with a corrected timestamp in the
database (`payload ? 'timestampCorrected'`); they go with the pilot data cleanup.

Left open from the list: the agent correcting its own timestamps with the
server time (fix 4), and a guard for timestamps far in the *past* (a clock
behind the server is reported by the alert but not corrected).

Side result: `pnpm test` was red on a loaded machine because the `gpio-` and
`s7-signal-source` tests waited a fixed 400 ms for the bridge process; they now
wait for the final `down` reading (up to 5 s), and `packages/backend/vitest.config.mjs`
gives `DATABASE_URL` a dummy default. `pnpm test`: shared 6, edge-agent 41,
backend 133 tests, all green (`8e6e532`).

## Slice 10 — Postgres stopped on node-dc (Oct 6, 2026)

Goal: what happens to the backend, the edge buffers and the data when the
database goes away for about three minutes (`systemctl stop postgresql@17-main`
on node-dc, the simulator rigs keep producing). A full disk was not provoked
(if the WAL disk fills up Postgres stops with a PANIC, which is the same
situation seen from the application).

**Code read before the test:** both failure paths in `mqtt-subscriber.ts` (the
machine registry lookup and `insertEvent`) return without acking, so the edge
keeps the event; there was no `pool.on("error")` handler in `db.ts`.

**Run 1 (backend as it was, 17:26:15 UTC, 3 min 28 s):**

| Check | Result |
|---|---|
| Backend | Crashed at the moment of the stop: `error: terminating connection due to administrator command` (`57P01`) → `Unhandled 'error' event` on the pg Pool. `Restart=on-failure` kept it in a restart loop (`activating (auto-restart)`, about one attempt a minute, each failing in `runMigrations` with `ECONNREFUSED`); the systemd start limit was not reached |
| Edge | Nothing lost: buffers grew (30 / 28 / 23 events after about a minute), no acks |
| Recovery | The backend came back by itself one second after the Postgres start (the next restart attempt) |
| Data | Events in the first buffered minute: 30 / 28 / 23 in the database, exactly the buffer contents; buffers 0 afterwards; no gap longer than 16 s in the window |

**Finding 9 — an unhandled pool error crashed the backend on every Postgres
restart.** Any restart of the database (package update, maintenance) took the
backend down, dropped the dashboard and websocket connections, and the return
depended on the systemd restart loop (up to about a minute after Postgres was
back). **Fixed** in `1091e82`: `pool.on("error")` logs (at most every 10 s)
and the pool reconnects on the next query; unit test `db-pool-error.test.ts`.

**Run 2 (after the fix, 17:33:42 – 17:35:51 UTC, 2 min 9 s):**

| Check | Result |
|---|---|
| Backend | Stayed up: `MainPID` and `NRestarts=0` identical before, during and after; log lines `ECONNREFUSED` / `failed to persist event — NOT acking` |
| API | `GET /api/machines` answered 401 in 5 ms (no hang). The dashboard showed "Error: Internal Server Error" while the database was away |
| Edge | Buffers grew to 40 / 40 / 34 events (17:35:01) and were empty after the start |
| Data | 40 / 40 / 34 events in the database in exactly those windows; no gap longer than 12 s since; new events arrived after the start without any backend restart |

Left open from this slice: a plain `500` for the dashboard during the outage
(a 503 "database unavailable" message would read better); a full disk itself
was not tested.

**Disk usage alerts (added after this slice, Oct 6, 2026).** Because the real
full-disk case is not safe to provoke, two alerts were added to see it coming:
`disk_space` (node-dc: `/` and the Postgres data directory, checked every 5 min,
`50a8deb`) and `edge_disk_space` (the disk of every online edge node, which
holds the event buffer; the agent reports it with claim and heartbeat from
`edge-agent-v9`, migration 042, `6777626`). Both raise at 85 % used or less than
2 GiB available and clear at 80 % (and 2.5 GiB), so a value at the limit does
not flap; the limits can be changed with `DISK_WARN_PERCENT`, `DISK_MIN_FREE_GIB`
and `DISK_CHECK_PATHS` in the backend environment. Verified live by lowering the
limit to 30 % and 10 % (no disk was filled): both alerts opened (20:19) and
resolved after the setting was removed (20:20:52). Reading from the live
numbers: node-gate has a 14.8 GiB disk, 42 % used, 8.5 GiB free.

## Slice 11 — expired broker certificate (Oct 6 to 7, 2026)

Question: what happens when the Mosquitto server certificate expires? Does the
monitor warn in time, what do the backend and the edge agent do, is any data
lost, and does the system come back without a restart of the agent?

**Part A — the monitor with a shifted date (Oct 6, node-dc).**
`MES_CERT_CHECK_NOW=<epoch> mes-cert-check.sh` evaluates the real certificate
files as of another date (the check writes the result to `job_status` like the
daily run).

| Date given | Result |
|---|---|
| 2027-09-15 | `expires in 16 day(s)` for the broker, nginx and Postgres certificates and `17` for the backend device certificate, exit 1 |
| 2027-11-01 | `EXPIRED on ...` for the same four, exit 1 |
| real run afterwards | `OK: 7 certificates`, state restored |

The `cert_health` alert did not show up in the first minutes because the
evaluator only runs every 10 minutes (`CHECK_INTERVAL_MS`). With the failed
result in place it was raised 3 minutes after the check (21:00:52 local time)
and resolved at the first evaluator run after the real state was restored
(21:20:52), without any manual step.

**Detour — the server CA passphrase was lost.** The real test needs a
certificate that is signed by the server CA and valid for only a few minutes
(`make-short-cert.py`, kept next to `mes-ca.sh` on the admin laptop; it signs
with the CA key and writes only to `issued/<name>`). The passphrase of
`~/mes-ca/root.key` (created Oct 1) was not known any more: both `openssl pkey`
and the script failed with `bad decrypt`, while the device CA's passphrase
worked. The key file and the certificate were consistent (same date, the
broker certificate verified against the root), so it was not a damaged file.
Nothing can be done about a forgotten passphrase, and without it no server
certificate can be issued or renewed. Because the CA was only five days old and
the certificates were due to be re-issued for a real DNS name anyway, the CA was
replaced (see "CA rollover" in `DEVELOPMENT_STATUS.md`): new root Oct 7 11:48 UTC,
fingerprint `49:91:D9:...`, certificates for the broker, nginx and Postgres
re-issued and installed without an outage of the trust chain (a two-root trust
file first, the swap second, the new root alone at the end). Both roots have the
same subject name; OpenSSL and Node chose the right one by key identifier.

**Part B — real expiry (Oct 7, UTC times).** A certificate valid from 12:04:43
to 12:21:43 (signed by the new CA) replaced the broker certificate at 12:11;
after expiry the broker was restarted so that every client has to do a new
handshake.

| Time | Observation |
|---|---|
| 12:11 | Broker restarted with the short certificate: backend and edge agent reconnected within 2 s, data flowing, `NRestarts=0` |
| 12:11 to 12:13 | Monitor runs before the expiry: `mosquitto-server: expires in 0 day(s)`, exit 1; the `cert_health` alert was raised at 12:15:46 |
| 12:21:43 | Certificate expires; the established connections were not watched at this moment |
| 12:22:04 | Broker restarted. Backend: `mqtt subscriber reconnecting…`, `certificate has expired`, `connection closed`, repeating every 2 s. Edge agent: the same. The backend did not crash (`MainPID` and `NRestarts=0` unchanged), `mes-backend`, nginx and Postgres stayed `active` |
| 12:22 | Monitor: `mosquitto-server: EXPIRED on Oct 7 12:21:43 2026 GMT`, exit 1 |
| 12:22:58 | Edge buffers 27 / 27 / 17 events (modbus / opcua / s7), oldest 12:22:05 to 12:22:08 |
| 12:24:07 | Edge buffers 61 / 62 / 40 events |
| about 12:24 | Original certificate and key copied back (`cp -a` from a checked backup), broker restarted. The edge agent reconnected at 12:24:25 **without a restart of the agent**; buffers 0 / 0 / 0 within seconds |
| 12:25:46 | The `cert_health` alert resolved by itself after the next evaluator run |

Data check. Events in the database inside the three buffer windows (from the
first to the last buffered timestamp of the 12:24:07 snapshot): modbus 61,
opcua 62, s7 40 — exactly the buffer contents, no loss, no duplicate. The longest
gap between two events in 12:20 to 12:27 UTC was 2.0 s (modbus), 12.0 s (opcua)
and 15.9 s (s7), which is the same range as the machines' normal pauses in the
earlier slices (up to 16 s); no baseline for this exact window was measured.

### Findings

12. **A forgotten CA passphrase cannot be recovered, and nothing in the process
    prevented it.** The server CA had been created five days earlier and its
    passphrase was kept nowhere. Consequence: the CA had to be replaced
    (cheap now, expensive after the pilot starts: every edge node and every
    tablet would need the new root). Rule added: before `mes-ca.sh init` the
    passphrase goes into the password manager and onto paper in a second place;
    the same for the device CA. Details in `DEVELOPMENT_STATUS.md`.
13. **An expired broker certificate stops every client at its next
    handshake, but costs no data.** Both the backend and the edge agent keep
    retrying every 2 s, the backend stays up, the edge buffers the events on
    disk and replays them after the certificate is fixed, without restarting
    any agent. The outage lasts as long as the certificate is wrong; with the
    monitor's early warning it is avoidable.
14. **The early warning works end to end.** The monitor reports the problem
    (16 days before expiry in part A) and the evaluator turns it into an alert
    within 10 minutes; it resolves by itself when the certificate is renewed.
    The message shows the wording of the last evaluator run, so in a short test
    it still said `expires in 0 day(s)` although the certificate had already
    expired by the time it was restored.
15. **A restore command emptied the certificate files and took the broker down
    for about 50 seconds (Oct 7, 11:59:32 to 12:00:20 UTC).** A restore line
    (`cat backup/cert.pem > /etc/mosquitto/certs/cert.pem`) was run before the
    backup existed: the shell truncates the target before `cat` fails on the
    missing source. The broker could not start and nginx's configuration test failed, so
    its reload did not happen. The backup taken afterwards copied the already
    empty files, so it was useless; the original certificates were still on the
    admin laptop. Recovery: the already
    prepared new certificate and key were installed and the broker restarted;
    the edge agent reconnected on its own at 12:00:20 and nothing was lost. As a
    side effect this was a second, accidental broker outage (about 50 s,
    refused connections) with the same recovery behaviour as slice 2. Method
    rules: a backup is checked (`test -s`) before anything is overwritten; a
    restore or install is chained with `&&` after that check; `cp` instead of a
    redirect for restores (it stops on a missing source); a key and certificate
    pair check with `diff <(…) <(…)` also "passes" when both files are missing
    (two empty outputs), so test the files first; and run server commands on
    the right host (node-dc, not node-gate).
16. **An established connection survives the expiry; only new handshakes fail
    (Oct 7, 12:45:20 UTC, tested with a second certificate valid for 17
    minutes).** The broker was restarted once with the short certificate
    (12:34 UTC), then nothing was restarted until after the expiry. The data age
    of the three machines stayed at 0 to 4 s across 12:45:20 (a 5 s and a 10 s
    sample before it are within the normal pauses), no `closed/reconnect/
    expired` line appeared in the backend or edge log, and the edge buffers
    stayed at 0: the open connections were not touched. A new handshake after
    the expiry failed at once (`openssl s_client`: `verify error:num=10:
    certificate has expired`, `notAfter=Oct 7 12:45:20 2026 GMT`), and so did
    the first reconnect of a restarted edge agent (every 2 s `certificate has
    expired`, broker log `unexpected eof while reading` / `Protocol error`,
    the client closes the handshake itself); the edge buffered meanwhile.
    After the good certificate was restored (`cp -a` from the checked backup,
    one broker restart) the edge reconnected without help and the buffers went
    back to 0 within a minute. Data: in the 12:44 to 12:53 window the longest
    gap between two events was 8 s (modbus), 14 s (opcua) and 19 s (s7), with
    two edge restarts (12:48:48 and about 12:49:50) and about two minutes of
    refused connections inside it, so the buffered events came back with their
    original timestamps. Practical meaning: an expired broker certificate does
    not stop the plant at the moment of expiry. It shows up later, at the first
    unplanned reconnect (network blip, broker or agent restart), which makes
    the early warning of the monitor the only reliable signal. The port of the
    TLS listener is 8884 (mutual TLS, the client certificates are checked
    against the device CA); the logs of the broker go to
    `/var/log/mosquitto/mosquitto.log` with epoch timestamps, not to the journal.
17. **The edge nodes' own client certificates were not watched in the system;
    now they are (edge-agent-v10, `790a1d9`, migration 043, Oct 7).**
    `mes-cert-check.sh` on node-dc covers the broker, nginx, Postgres, both
    roots and the backend's device certificate, but the certificate of node-gate
    (`/etc/mes/mqtt-client/cert.pem`, valid to Oct 2, 2027) was covered only by
    `mes-ca.sh status` and the calendar reminders on the admin laptop. An
    expired client certificate stops that node (new handshakes fail, see 13 and
    16: buffered, no loss). Fix: from v10 the agent reads the expiry of the
    certificate it loaded and sends it with the claim and every heartbeat; the
    backend stores it (`edge_nodes.client_cert_expires_at`), the Edge nodes page
    shows it and the system alert `edge_cert_expiry` opens when any node's
    certificate expires within 30 days (`EDGE_CERT_WARN_DAYS`) or has expired,
    checked at start and every 10 minutes, and resolves by itself. Verified
    live: after the agent start the database showed `2027-10-02 07:54:40+02` for
    `node-gate-sim`; with `EDGE_CERT_WARN_DAYS=400` (temporary systemd drop-in)
    the backend log said `... node-gate-sim (expires in 360 days)` within 8 s of
    the restart, the alert appeared on the dashboard, and removing the drop-in
    resolved it (`edge node client certificates are valid again`). Still not
    done: a real expiry of a client certificate on a running node.

## Slice 12 — network partition with dropped packets (Oct 7, 2026)

**Setup.** nftables on node-gate dropped the packets to and from node-dc on the
MQTT port (8884) and the HTTP port (443), SSH untouched, for 240 s; a timer removed
the rules by itself (`nft delete table inet chaos`). Unlike "connection refused"
(slices 2 to 8) nothing answers: the connection just goes silent, which is what a
cable or switch failure looks like. The machines kept producing (about 0.5 events/s
for the Modbus and OPC UA rigs, fewer for S7).

**Result 1 (edge-agent-v10), 13:14:55 to 13:18:55 UTC.**

| Time | What happened |
|---|---|
| 13:14:55 | partition starts; the data age on the dashboard grows from here |
| 13:16:25 | the agent notices: `connection to broker closed` (90 s, the default MQTT keepalive is 60 s) |
| 13:16:27 to 13:19:07 | every reconnect attempt hangs for 30 s (default connect timeout) plus 2 s pause, 32 s per cycle |
| 13:18:55 | partition removed |
| 13:19:08 | agent connected again (13 s after the removal), the buffers (0 / 0 / 0 afterwards) emptied within one sample |

Data: 127 / 129 / 91 events had been produced in the partition (Modbus / OPC UA /
S7), `stored_during = 0` (none reached the database while the network was down),
all of them arrived after the removal with their original timestamps, `n = uniq`
(no duplicate rows), longest gap between two events 10 s / 4 s / 18.9 s. Nothing was
lost, as the code promises: the agent writes every event to the buffer file
first and removes it only on the backend's application-level ack.

### Findings

18. **Silent connection loss is noticed late and recovered late with the default
    MQTT settings.** Detection took 90 s (60 s keepalive) and each reconnect
    attempt hung for 30 s, so after the network came back the agent could be up to
    32 s late. Nothing is lost during that time (the buffer takes the events), but
    the dashboard is stale for the whole span. **Fixed in edge-agent-v11
    (`f9a6eaa`):** `keepalive: 15` and `connectTimeout: 10000` set explicitly on
    both MQTT clients. Measured in the re-run (below): detection after 21 s,
    reconnect cycle 12 s (so at most about 12 s after the network is back).
19. **After a long outage the edge agent and the backend ran a retry storm that
    made the dashboard unusable for about 30 s (fixed in edge-agent-v11 and the
    backend, `f9a6eaa`).** The Alerts page requests right after the removal took
    19 s, 35 s, 15 s and 13 s (second run: 14 s, 14 s, 10 s). Not the
    database (no active query over 2 s, no lock wait, no `idle in transaction`,
    at most 8 of 20 pool connections open), but the Node process: 30 s at a steady
    45 % CPU, then a burst of 223 inserts in 2 s. The Postgres log explained it:
    about **70 `duplicate key` errors per second for those 30 s**, about 2000 for
    350 real events (2473 and 2266 in the two other runs, 8148 in the log in
    total). Causes: (a) every retry sweep (every 4 s) republished the *whole*
    buffer, so while the backend was still working through the backlog the same
    events came again; (b) the agent rewrote the whole buffer file once per ack,
    including the acks of duplicates, which kept it busy and so slowed the
    removals that would have stopped the resending; (c) the backend answered each
    duplicate with a unique violation exception (error object, Postgres error
    line) and an ack. Fix: a retry tracker (an event is republished only 15 s after
    the last send, at most 300 per sweep, forgotten on every reconnect), acks
    removed in batches (one read, at most one write, nothing written when the id
    is not in the buffer), and `INSERT ... ON CONFLICT DO NOTHING` in the backend
    (`rowCount = 0` means duplicate). 16 new unit tests (retry tracker 4, ack
    batcher 4, buffer 3, insert 5). **Re-run with v11, 14:08:44 to 14:12:44 UTC:**
    `duplicate key` errors **0** (the log counter stayed at 8148), backend CPU at
    or above 20 % for **1 s** (one 32 % sample at 14:12:45) instead of 30 s, **no
    request over 1 s**, `n = uniq`, longest gap 6 s / 6 s / 16.2 s, buffers 0. The
    agent noticed the loss after 21 s (14:09:05) and retried every 12 s.
20. **Open: nothing raises an alert when an edge node goes offline.** The 4 minute
    partition (and the one in the first run) produced no alert at all
    (`alerts` had no new row). The "online" state of the Edge nodes page uses
    `HEARTBEAT_STALE_SECONDS = 90`, but it is only a display; the clock, disk and
    certificate evaluators ignore offline nodes (the certificate one reports them),
    and the rule evaluator only runs rules a user created (none active). What the
    Edge nodes page showed during the partition was not recorded. Proposed:
    system alert `edge_node_offline` for a node seen before that has sent no
    heartbeat for 3 minutes (longer than the display threshold so a restart does
    not flap), resolving by itself when it comes back.

Observation for later (not changed): the unique index is on
`(source_event_id, timestamp)`, and an event stamped in the future is stored with the
receive time (slice 9). A resend of such an event after a lost ack gets a different
timestamp and is therefore not recognised as a duplicate. Worth a test before the
pilot.

## Not tested yet

- A real power cut of the edge node hardware: size of the unsynced loss at the
  end of the buffer file (the container stop in slice 6 cannot show it).
- `systemctl stop` while the broker is unreachable by dropped packets (not
  refused): the 5 s forced exit of v6 is expected to bound it; only the refused
  case was measured (slice 8). The partition itself (without a stop) is slice 12.
- The settings API itself (`PATCH /api/edge-nodes/:id/settings`) against the
  live backend with a real session; the live test above changed the value in
  the database. Route logic is covered by unit tests.
- A full disk on node-dc (the Postgres stop is slice 10; a full disk is only
  inferred from it); a clock behind the server (the clock ahead was tested in slice 9; the
  alert covers both directions, the ingestion guard only the future; the
  behind case itself was not run live).
- A real expiry of an edge node's client certificate (it is monitored since
  v10, finding 17; the stop itself is inferred from the broker case, findings
  13 and 16).

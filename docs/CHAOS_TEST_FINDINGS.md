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
   (new events are older than the existing ones; confirmed in slice 15).
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
(a 503 "database unavailable" message would read better; done in slice 19);
a full disk itself was not tested.

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
20. **Nothing raised an alert when an edge node went offline; now it does
    (`347000d`, backend only, no agent release).** The 4 minute partition (and the
    one in the first run) produced no alert at all (`alerts` had no new row). The
    "online" state of the Edge nodes page uses `HEARTBEAT_STALE_SECONDS = 90`, but it
    is only a display; the clock, disk and certificate evaluators ignore offline nodes
    (the certificate one reports them), and the rule evaluator only runs rules a user
    created (none active). What the Edge nodes page showed during the partition was
    not recorded. Fix: system alert `edge_node_offline` (new
    `edge-offline-health.ts` and `edge-offline-health-evaluator.ts`, checked every
    60 s): a node that has reported before and has been silent for more than 3
    minutes (`EDGE_OFFLINE_ALERT_SECONDS`, 120 to 86400, default 180; deliberately
    longer than the 90 s display label so a restart or deploy does not flap). The
    last sign of life is the last heartbeat; a cleanly stopped node has none (the
    lease is released) and is measured from `last_seen_at`, so a node that was stopped
    and forgotten is reported too ("stopped 12 min ago"); a node that never reported
    is not. After a restart of the backend the evaluator does not look for as long as
    the limit (the nodes' last heartbeats are old only because the backend was not
    there to receive them). The alert lists up to five nodes, the longest silent
    first, and resolves by itself. 13 new unit tests; `pnpm test` is green (edge-agent
    56, backend 194). Verified live: the node was stopped with `systemctl stop
    mes-edge-node`; at the first check after the backend restart (05:13:35 UTC) the log
    said `edge node offline alert raised` with `node-gate-sim (stopped 3 min ago)` and
    the alert was on the dashboard; the node was started again at about 05:15 and the
    alert resolved at 05:15:35 (`all edge nodes are reporting again`).

Observation for later (not changed): the unique index is on
`(source_event_id, timestamp)`, and an event stamped in the future is stored with the
receive time (slice 9). A resend of such an event after a lost ack gets a different
timestamp and is therefore not recognised as a duplicate. Worth a test before the
pilot. (Confirmed and fixed in slice 16, finding 32.)

## Slice 13 — `systemctl stop` with dropped packets, start without network (Oct 8, 2026)

**Setup.** Same nftables partition as slice 12 (packets to and from node-dc on ports
8884 and 443 dropped, SSH untouched), removed by a timer after 100 s. 15 s into it
(05:18:58 UTC) `systemctl stop mes-edge-node` on node-gate, timed. Then, by an
unplanned timing slip, `systemctl start` already at 05:19:32 while the partition was
still on (it ended at 05:20:23): so this slice shows both a stop and a start without
any network. The machines kept producing throughout.

| Time (UTC) | What happened |
|---|---|
| 05:18:43 | partition starts (last heartbeat reached the server at 05:18:14) |
| 05:18:58 to 05:19:03 | `systemctl stop`: `real 0m5.036s`, `Result=success`, exit status 0. The agent logs `shutting down…`, the lease release (HTTP) times out after 3 s (`The operation was aborted due to timeout`), the unit goes `inactive` |
| 05:19:04 to 05:20:24 | on the server the session stays (`session=true`), the heartbeat age grows from 49 s to 130 s; the edge node offline alert does not fire (silent for 131 s, limit 180 s) |
| 05:19:32 | `systemctl start` with the network still down: the claim (HTTP to the backend) fails after 12 to 13 s with `Connect Timeout Error`, the process exits with status 1, systemd restarts it after 2 s; three such rounds (05:19:45, 05:19:59, 05:20:14), about 14 s each |
| 05:20:23 | partition removed |
| 05:20:25 | the fourth start claims at once (the old session was 130 s without a heartbeat, so the lease was free since 05:19:44), `claimed edge node, starting channels`, all three channels started within 0.2 s, connected to the broker |
| 05:20:25 to 05:20:26 | catch-up for the gap of about 90 s: S7 22 good / 3 scrap (gap 92 s), Modbus 38 / 6 (90 s), OPC UA 39 / 2 (89 s); the buffers (7 / 5 / 6 events from before the stop) went to 0 |

Data (05:17 to 05:22 UTC): `n = uniq` for all three machines (151 / 141 / 92 events, no
duplicates); the longest gap between two events is 1 min 29.6 s (Modbus), 1 min 28.6 s
(OPC UA) and 1 min 31.8 s (S7), which is the time nobody observed the machines
(stop 05:18:58 to channels started 05:20:25, about 87 s): the produced parts are
booked at the end by the catch-up, one booking per machine, not spread over the gap.

### Findings

21. **Resolved in edge-agent-v12 (slice 14): the edge agent could not start without the
    backend, so it collected nothing while the backend or the network was unreachable.** The channel configuration comes
    from the claim response and is not stored on the device. A start without a
    reachable backend (a power cut or reboot of the device while node-dc or the network
    is down, as above) ends in a crash loop, one try every ~14 s (12 s connect timeout
    plus 2 s restart delay, or ~2 s per round when the connection is refused). During that
    time no channel runs: no events, no buffer. What survives is only what the catch-up
    can rebuild from the counters of the machines (good and scrap parts, within
    10 minutes, slice 7); status changes are lost, and parts older than 10 minutes too.
    Slice 4 (start with the broker down) worked because the claim itself goes through
    HTTP. A fix needs a design decision: keep the last claimed configuration on the
    device (next to the buffer) and start the channels from it when the claim fails,
    claim in the background and adopt the lease when it succeeds. The lease exists so
    that two agents never read the same machine (that would double count, because
    every event gets its own random id); an offline start has no lease, so the risk is
    a second device for the same machines started at the same time.
    **Fix:** `edge-agent-v12` (`10b52ab`), verified live in slice 14 below.
22. **A `systemctl stop` is bounded and clean even when nothing gets through, and the
    lease recovers on its own.** The stop took 5.04 s (the 5 s forced exit of v6 holds
    for silent connections, not only for refused ones, slice 8), the lease release
    gave up after 3 s and left the session on the server, which hands the node over
    to the next claim as soon as the last heartbeat is 90 s old; no manual step. The
    catch-up booked the unobserved time, nothing was duplicated. The edge node offline
    alert (finding 20) correctly did not fire for a silence shorter than 3 minutes.

## Slice 14 — start without network from the cached configuration (Oct 8, 2026)

**Fix under test (finding 21, `edge-agent-v12`, commit `10b52ab`).** After every
successful claim the agent saves the channel configuration and the node settings to
`claim-cache.json` next to the buffer (written atomically, mode 0600, bound to the node
token by a hash, at most 7 days old, `CLAIM_CACHE_MAX_AGE_HOURS`). If the claim fails
because the backend cannot be reached (no answer, timeout after 10 s, 5xx, 408, 429),
the channels start from the cache without a lease and the agent claims in the
background (after 5, 10, 20, 40 s, then every 60 s). A claim that is answered with a
4xx (invalid token, node removed, lease held by another instance) is never bypassed:
no offline start. In the background, a lease that stays rejected for 150 s (the 90 s
stale limit plus margin) means another instance owns the node: the channels stop and
the agent exits, the buffer stays on disk. On success the lease is adopted, the
heartbeat starts, the cache is refreshed, and the channels are restarted if the
configuration changed meanwhile. 24 new tests (edge-agent 56 to 80).

**Setup.** Deployed on node-gate with `scripts/deploy-edge-agent.sh edge-agent-v12`;
`claim-cache.json` (984 bytes, `-rw-------`) appeared with the first claim. Then the
nftables partition of slice 12 (ports 8884 and 443 to and from node-dc dropped, SSH
untouched, removed by a timer after 240 s) and, 10 s into it, `systemctl restart
mes-edge-node`: the stop runs without network (the lease release times out) and the
start has no network either. The machines kept producing.

| Time (UTC) | What happened |
|---|---|
| 05:35:29 | partition starts; 05:35:34 the old process stops (lease release times out after 3 s, session stays on the server) |
| 05:35:41 to 05:35:51 | new process: claim runs into the 10 s timeout, `backend unreachable — starting channels from the cached configuration WITHOUT a lease`, all three channels started at 05:35:51, no crash loop |
| 05:35:51 to 05:35:52 | catch-up for the gap of 18 to 19 s: S7 3 good, Modbus 8, OPC UA 8 good / 1 scrap |
| 05:36:06, 05:36:26, 05:36:56, 05:37:46, 05:38:56 | `background claim failed ... unreachable`, next try in 10, 20, 40, 60, 60 s (each attempt also waits for its 10 s timeout); the broker connection reconnects every 12 s (`connack timeout`) |
| 05:39:29 | partition removed (timer); the broker connection is back within the same second |
| 05:39:56 | background claim succeeds: `claimed edge node after an offline start — lease adopted` (27 s after the network came back, the next scheduled attempt) |
| 05:41 | unit active, database: `has_lease = true`, last heartbeat 07:40:56 local time, i.e. regular |

Data (last 15 minutes, includes the whole test): `n = uniq` for all three machines
(426 / 435 / 282 events, no duplicates); buffers 0 (checked after the heal); the longest
gap between two events is 24.0 s (Modbus), 18.3 s (OPC UA), 18.8 s (S7), i.e. only the
18 s in which the old process was stopped and the new one had not yet started; in
slice 13 the same situation without the fix left a gap of 1:29 to 1:32. During the
partition the channels kept counting and the events went to the disk buffer.

### Findings

23. **An offline start from the cached configuration works and loses nothing.** The
    node counted for the whole 4 minutes without a backend, caught up the 18 s of its
    own restart, sent its buffer after the heal and took the lease back by itself. The
    lease adoption can take up to about 70 s after the network is back (60 s backoff
    cap plus the 10 s claim timeout); events are not affected, only the Edge nodes
    page shows the node without a session meanwhile.
24. **Not covered by the live run (since tested, slice 18):** the 150 s give-up rule (a lease that stays
    rejected) and the 4xx refusal at start were covered by unit tests only; in this run
    the old session was already stale and the first answered claim succeeded. The
    status code the backend sends for "lease held" was not checked; every 4xx is treated
    as a rejection. Without a lease two devices reading the same machines would still
    double count until the first background claim is answered, which is the accepted
    risk of option A.

## Slice 15 — clock of the edge node behind the server (Oct 8, 2026)

**Method.** As in slice 9: only the clock of the agent process was shifted, with
`libfaketime` (`FAKETIME=-5m`, `DONT_FAKE_MONOTONIC=1`) in a temporary systemd drop-in on
`mes-edge-node` (node-gate). Restart with the shifted clock at 05:46:33 UTC, restart
without the drop-in at 05:49:45 (3 min 12 s). Broker and backend were up. The `LD_PRELOAD`
and `FAKETIME` variables were gone from the process after the restore (checked).

| Observation | Result |
|---|---|
| Detection | The agent logged at error level "The clock of this device is 300 s behind the server's" (`clockAheadMs -300051`); `edge_nodes.clock_offset_ms = -300126`; the alert `edge_clock_skew` appeared on the dashboard ("node-gate-sim (5 min behind) ... can hide real status changes") and was gone from the active alerts after the restore |
| Ingestion | All events of the period are stored with the shifted timestamp: `created_at - timestamp` = 300 s for every event (240 events, 240 distinct ids, stamped 07:41:36 to 07:44:44 local time). The ingestion guard only looks at the future, nothing is corrected or marked |
| Catch-up at the start (clock behind) | `clock_back` live for the first time: the stored state is 295 to 296 s in the future, the parts of the (real, a few seconds long) restart gap were **not booked**: S7 1 good, Modbus 1 good, OPC UA 2 good. Nothing was booked wrongly |
| Catch-up at the restore | Gap 304 to 306 s (the stored state carries the shifted time): 2 good per machine booked from the counters; this is the counter difference since the stored baseline, no duplication seen (events 240 = 240 distinct) |
| Status shown by the "latest timestamp" views | The new events are older than the real events already stored (up to 07:46:33), so for the whole 3 min 12 s the newest status by timestamp stays the last one from before the test. Of the 4 real `down` periods in the window (Modbus 07:47:30, OPC UA 07:49:03, S7 07:47:17 and 07:48:27, about 8 to 10 s each) **all 4 were hidden**: at the arrival of each `down` event the view still said `running`. A view by timestamp returns to normal with the first event stamped with the real time (07:49:48) |
| Mixed streams | The period 07:41:36 to 07:44:44 now holds two event streams, the real one from the first run and the shifted one: a timeline of that period shows both. Test data, to be removed with the pilot data cleanup (`created_at - timestamp > 200 s` finds it) |

### Findings

25. **The detection chain works in both directions.** Agent log, offset on the Edge nodes
    page, alert and its self-resolution behaved as for a clock ahead (slice 9); the
    alert text is right for "behind".
26. **A clock behind the server hides real status changes, as predicted in finding 9.**
    All four real `down` periods in the window were invisible to every view that takes
    the status with the latest timestamp; production events are booked in the minutes
    of the past (a shift boundary would be crossed by a large skew). The alert is the
    only protection; the data are wrong while it lasts and afterwards.
27. **The `clock_back` rule is confirmed live.** At the start with a shifted clock the
    parts of the restart gap are dropped, not booked wrongly (finding 10, backward case).
    This costs a few parts per restart while the clock is wrong.
28. **A guard for old timestamps at the backend cannot work.** A delayed event is not a
    wrong one: after an outage the agent delivers buffered events that are legitimately
    minutes or hours old (slices 2 to 8, 11, 12), so "stamped long before the receive
    time" cannot be told from a wrong clock. The fix has to be in the agent: it already
    measures its offset at the claim (`serverTimeMs`) and could stamp events and
    compute the catch-up age with the corrected clock, re-measuring on the heartbeat
    (fix 4 of the slice 9 list). Decided on Oct 8 and implemented in edge-agent-v13 and v14 (follow-up below).
    Without a measurement (a start without the backend, finding 21) no correction is
    possible, which is another reason to keep the time-sync dependency of the unit
    (v7).

### Follow-up: the agent corrects its timestamps (edge-agent-v13 and v14, Oct 8, 2026)

Decision for finding 28: option A, agent-side correction. The claim and every heartbeat
response carry the server time (`serverTimeMs`); the agent measures its offset (round
trip over 5 s is rejected; a difference under 2 s is ignored, changes under 0.5 s are
treated as jitter) and stamps events, the counter baseline and the catch-up age with the
corrected clock. Durations and timers are not touched. The heartbeat still sends the
**raw** device time, so `clock_offset_ms` and the `edge_clock_skew` alert keep working.

**v13 verified live** (clock −5 min at the start): `created_at - timestamp` about 0 for
598 events (5 more in the 20 s bucket), no `down` period hidden (34 status changes, the
view by timestamp showed each new status; slice 15 without correction hid all 4), no
`clock_back` at the start, alert and offset preserved (raw heartbeat −300 006 ms).

29. **v13 broke the parts of a clock step: the correction restarted the channels.**
    A step of the device clock during the run (−5 min to −4:30) was detected by the
    heartbeat (300 051 to 270 005 ms), but applying it restarted the channels. After the
    restart the stored state carried the old correction, the catch-up reported
    `clock_back` and the parts of the gap were not booked. Cause: the S7 Python bridge
    got the offset only through its environment at the start.
30. **Every channel restart leaked listeners.** `setupChannel` added its reset and
    message listeners to the MQTT client and never removed them; after a few restarts
    Node logged `MaxListenersExceededWarning`. Existing bug, made visible by finding 29.
31. **Procedure artifact, not a product defect.** Deleting `/run/faketime.rc` under a
    running process makes libfaketime fall back to the real time, which produced a
    +266 s stamped state in one test. The restore order is: stop the service, remove the
    drop-in and the file, `daemon-reload`, start.

**v14** (fixes 29 and 30): the offset is published to the S7 bridge through a file
(`CLOCK_OFFSET_FILE`, written atomically, re-read by `clock_offset.py` at most once a
second), so a change of the correction needs **no restart**; the channels restart only for a
changed configuration. The listeners are named and removed in `stop()`, and the ack
batcher is flushed on stop.

**v14 verified live** (node-gate, −5 min at the start, step to −270 s after 78 s, restore):

| Observation | Result |
|---|---|
| Start with −5 min | `clock of this device is 300 s behind … timestamps are corrected`; `clock-offset` file `300053`; channels started once |
| Step to −270 s | `timestamp correction changed 300053 → 270004`, file `270004`, **no** `restarting channels` |
| Restore (stop, remove, start) | no correction line, file `0`, no `LD_PRELOAD` / `FAKETIME` in the process |
| Journal, 12 min | 0 matches for `restarting channels`, `MaxListeners`, `clock_back` |
| Database, 09:22 to 09:28 | 452 events with `created_at - timestamp` about 0, 20 events 30 s **ahead**; 0 rows with `timestampCorrected`; the status by latest timestamp equals the latest arrived status for all three machines |
| Dashboard | the clock alert appeared during the test and was gone after the restore |

**Known limitations (accepted).**
- After a clock step the agent learns the new offset only at the next heartbeat (at most
  30 s). Events in that window are off by the size of the step: 20 events were 30 s ahead
  in the test, below the 60 s ingestion guard. A step over 60 s forward is clipped by the
  guard (stored with the receive time, marked); a step backward is hidden in the same way as
  before for at most 30 s.
- Without contact to the backend (start from the cached configuration, finding 21) there
  is no measurement and no correction; the alert and the time-sync dependency of the unit
  remain the protection. The correction starts with the first successful claim.
- The test left 20 events stamped 30 s ahead and the earlier shifted streams of slices 9
  and 15 in the database; the pilot data cleanup finds them with `created_at - timestamp`
  over 200 s or under -20 s and with `payload ? 'timestampCorrected'`.

## Slice 16 — resend of an event stamped in the future (Oct 8, 2026)

Found by reading the code (the open item of slice 12, "a resend of such an event after a lost ack
gets a different ..."), confirmed against the schema, fixed and verified on the database.

32. **A resent event that the guard had corrected was stored twice.** The unique index of
    `events` is `(source_event_id, "timestamp")` (sql/027, needed because `timestamp`
    is the hypertable partition column) and the ingestion guard replaces the timestamp of an
    event stamped more than 60 s in the future with the receive time. The resend after a
    lost ack carries the original timestamp: the guard turns it into another receive time (or,
    once the original is less than 60 s ahead, leaves it), so the row never conflicts with the
    stored one. A duplicate production count would have been the result. The window is small
    since the agent corrects its clock (v13, v14): a clock step over 60 s inside the ≤30 s
    detection lag, or a start without the backend, with a lost ack on top.

**Fix** (backend only, `d22b332`, migration 044): the table `event_timestamp_corrections`
(`source_event_id` primary key) lists the events whose timestamp was corrected. `insertEvent` is
still one statement: it inserts the event only if its id is not listed, still with `ON CONFLICT
DO NOTHING`, and in the same statement lists the id when the event was corrected (data-modifying
CTE, atomic). A resend, whenever it arrives and with whatever timestamp, writes no row and is
reported as a duplicate; the correction is reported once. 5 new tests; `pnpm test` is green:
shared 6, edge-agent 95, backend 199.

**Verified** on the live database (hypertable `events`) in a transaction that was rolled back: the
event stamped now, listed as corrected -> 1 row written; the same id with a stamp 2 minutes later,
listed as corrected -> 0 rows; with a stamp 3 minutes later, not listed as corrected -> 0 rows;
`count(*)` for the id = 1. (The statement was also checked on a plain PostgreSQL 16 with the same
column types and untyped parameters, as the driver sends them.) By the definition of the index the old
statement writes three rows for the same sequence (the old statement was not run on the live
database).
The table grows only by corrected events; old rows can be deleted (no automatic cleanup yet).

## Slice 17 — settings API with a real session (Oct 8, 2026)

**Method.** On node-dc against the live backend (`127.0.0.1:3001`) with a real login of an admin
account (password, then the MFA code; the two-step login worked as designed, the password and
the token were not written to any file or to the screen). Edge node `node-gate-sim`,
setting `catchupMaxMinutes` (10 before and after).

| Request | Result |
|---|---|
| PATCH without a token, with an invalid token | 401 `authentication required` |
| GET the settings | 200 `{"catchupMaxMinutes":10}` |
| PATCH `-1`, `1441`, `1.5`, `"10"`, `null` | 400 `catchupMaxMinutes must be an integer between 0 and 1440` each |
| PATCH unknown key, `{}`, `[]` | 400 (`unknown setting: foo`, `no settings given`, `body must be a JSON object`) |
| PATCH an unknown node id | 404 `unknown edge node` |
| After all rejected requests | the value in the database is unchanged (10): nothing was written |
| PATCH `7` | 200; GET and the database show 7 |
| Audit log | one `edge_node_settings_updated` row: actor and e-mail of the account, `target` = node id and `{"catchupMaxMinutes":7}`, IP `127.0.0.1` |
| Agent | after a restart of `mes-edge-node` the claim cache holds `catchupMaxMinutes: 7` (the claim carries the setting) |
| Restore | PATCH `10`: 200, database and agent cache back to 10; logout 204 |

No finding: the route behaved as the unit tests describe. Not tested live: a role that is not
allowed (403). A setting changed here reaches the agent at its next claim, that is at its next
start (as documented for v5); there is no push to a running agent.

## Slice 18 — refused claims and a lost lease (Oct 8, 2026)

**Method.** `node-gate-sim` on the live backend, without touching the real token: the token is made
invalid by prefixing the stored hash with `zz` (and restored), another instance is simulated by a
`psql` loop on node-dc that writes a foreign `current_session_id` and a fresh `last_heartbeat_at`
every 20 s. The lease is stale after 90 s without a heartbeat (`HEARTBEAT_STALE_SECONDS`).

| Test | Result |
|---|---|
| Start with an invalid token (edge-agent-v14) | The claim answers 401 `invalid token`, the agent does **not** start from the cache, logs `ClaimHttpError` at error level and exits 1; systemd restarts it after 2 s: 10 restarts in 44 s (about 4.5 s per cycle, 2 to 2.6 s CPU each). After the hash was restored the agent claimed within 2 s, unattended |
| Start while the lease is held (v14) | The claim answers **409** `another instance of this edge node is already active` (`DuplicateSessionError`), no start from the cache, the same restart cycle. After the last foreign heartbeat the agent claimed at +90 s |
| Lease replaced while the agent runs (v14) | Heartbeat answer 409; the agent logged **nothing**, kept running and publishing, and the node became offline for the dashboard (finding 33) |
| Lease replaced once while the agent runs (v15) | Detected 14 s later (`status: 409`, warn), background claims refused at +5, +15, +35 s, **adopted at +89 s** (`claimed edge node again after the lease was lost — lease adopted`); same process (`MainPID` and `NRestarts` unchanged), channels never stopped |
| Lease held by a live second instance (v15, simulated for 4 minutes) | Claims refused for ~186 s after the first refusal, then `the backend keeps rejecting the claim` and `shutting down…`, exit 1 (150 s grace, the attempts fall at +10, +30, +70, +130, +190 s). Restart cycle of about 4.6 s (21 restarts in 97 s) while the foreign lease was fresh; the agent claimed **3 s** after the lease became stale (12:49:23) without intervention |

33. **A running agent did not notice that it had lost its lease.** `sendHeartbeat` turned every
    non-2xx answer into "no measurement": a 409 (another instance has the session, or the backend
    forgot it) was neither logged nor handled. The node showed as offline (and, after 3 minutes,
    raised `edge_node_offline`) although it kept publishing, and a second device holding the same
    token (the spare edge hardware) would have read the same machines in parallel without any
    limit: event ids are random per event, so the database cannot deduplicate them. Fixed in
    **edge-agent-v15**: a refused heartbeat (4xx except 408 and 429) starts a background claim (the
    v12 mechanism) with the channels still running; if the claim succeeds the lease is adopted
    without a restart, if the backend keeps refusing for 150 s the agent stops. 5xx, timeouts and
    network errors stay transient, now logged. At most about 150 s of parallel operation in the
    real conflict case.
34. **Observation, not changed: the restart cycle on a refused claim.** An invalid token or a lease held
    by someone else makes the agent exit and the unit restart it every 4.5 s (a claim, 2 s of CPU and an
    error line each time) for as long as the condition lasts: 13 claims per minute on the backend and
    a busy edge node. The behaviour is correct (nothing is published without a lease) but noisy; a
    longer `RestartSec` for exit code 1 or an in-process wait with the 5 to 60 s backoff before the exit
    would reduce it. Open, low priority.

The dashboard alert `edge_node_offline` during the 4 minute lease test was not recorded.

## Slice 19 — 503 and a banner while the database is unavailable (Oct 8, 2026)

Follow-up of slice 10 (the dashboard showed "Internal Server Error" while Postgres was away).

**Change.**
- Backend (commit `c8400f9`, `database-unavailable.ts`): an error handler, registered directly after
  `Fastify()` so that the encapsulated plugins inherit it, answers `503` with
  `{ code: "database_unavailable", … }` and `Retry-After: 5` when the database cannot be reached;
  any other error goes on to the default handler. The warning in the log is rate limited.
- `GET /health?db=1` (commit `f60bb93`, `database-health.ts`) runs `SELECT 1` with a 2 s timeout and
  answers 503 `database_unavailable` on failure. The plain `/health` stays a pure liveness check
  (200 while the process is up), so a monitor that only needs "is the backend alive" is not tripped
  by a database outage.
- Dashboard (commit `f60bb93`): `apiFetch` passes every answer of our own backend to
  `database-status.ts`; a 503 with that code shows the banner "Database unavailable" below the top
  bar. While it is shown the banner asks `/health?db=1` every 5 s. When the database is back it
  turns into "The database is available again. Reload the page to refresh the data." with
  Reload and Dismiss.

**Live test.** `systemctl stop postgresql`, 15 s, `systemctl start postgresql`, dashboard open on
Alerts, logged in.

| What | Result |
|---|---|
| `GET /health?db=1` during the outage | `503`, `retry-after: 5` |
| `GET /health` during the outage | `200` |
| Dashboard | banner "Database unavailable." appeared, the panel showed its own "database unavailable" line; the page made `/health?db=1` requests; after the start the banner turned into "The database is available again" with Reload and Dismiss; the user stayed logged in |
| Backend log | two "database unavailable" lines in 5 minutes (rate limited) |

Every authenticated request answers 503 during the outage, also one with a bad token: the session is
looked up in the database, so the backend cannot tell a bad token from a good one. This is
consistent and documented; the first expectation (`/api/machines` still answering 200 or 401) was
wrong.

### Findings

35. **Fixed: the plain 500 on a database outage.** Now 503 with `Retry-After`, plus the banner above.
36. **Process finding, not a code bug: the first banner test ran the old frontend.** The build
    (`pnpm --filter @mes/frontend build`) writes to `packages/frontend/dist`, but nginx serves
    `/var/www/mes`; the copy step was missed after the build, and the browser kept running
    `index-DsOmNQzk.js`. The test had shown the panel's own error line, not the banner. The cause was
    found by comparing `[...document.scripts].map(s => s.src)` in the browser console with the
    `index-*.js` name in `dist/assets`. Deploy step (also in `DEVELOPMENT_STATUS.md`):
    `cp -a ~/mes/packages/frontend/dist/. /var/www/mes/`. Old `index-*.js` files accumulate in
    `/var/www/mes/assets` (eight at the time); harmless, can be cleaned by hand.

## Not tested yet

- A real power cut of the edge node hardware: size of the unsynced loss at the
  end of the buffer file (the container stop in slice 6 cannot show it).
- The settings API with a role that is not allowed (`operator` and below should get
  403): slice 17 had only an admin session; the role check is covered by unit tests.
- A full disk on node-dc (the Postgres stop is slice 10; a full disk is only
  inferred from it); the clock of a device that has no network while it is wrong
  (slice 15 had the backend reachable, so the agent could measure the offset).
- A real expiry of an edge node's client certificate (it is monitored since
  v10, finding 17; the stop itself is inferred from the broker case, findings
  13 and 16).

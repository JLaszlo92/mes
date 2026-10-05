# Chaos Testing Findings — M8

**Date:** September 21, 2026 (slice 1), October 5, 2026 (slices 2 and 3)
**Scope:** Slice 1: outage testing of the four signal sources (GPIO, S7, OPC-UA, Modbus), per ROADMAP M8 ("offline-resilience chaos testing"). Slice 2: outages of the transport and of the edge agent itself. Slice 3: re-test of the edge agent after `edge-agent-v5` (catch-up, lease release).

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
   cut can still lose the last second or two.
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

### Not tested yet

- `kill -9` while the buffer is not empty (the broker stopped first), and a
  full node-gate reboot — they would confirm the on-disk buffer survives.
  After `kill -9` the catch-up rule should also be checked (the stored counter
  values are at most a few seconds old; the gap includes the lease wait).
- The settings API itself (`PATCH /api/edge-nodes/:id/settings`) against the
  live backend with a real session; the live test above changed the value in
  the database. Route logic is covered by unit tests.
- Postgres stopped / disk full on node-dc; network partition between the
  nodes; clock skew between the edge node and node-dc (event timestamps use
  the edge clock; the catch-up age also uses the edge clock); an expired
  broker certificate.

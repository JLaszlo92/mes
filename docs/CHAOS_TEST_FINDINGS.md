# Chaos Testing Findings — M8

**Date:** September 21, 2026 (slice 1), October 5, 2026 (slice 2)
**Scope:** Slice 1: outage testing of the four signal sources (GPIO, S7, OPC-UA, Modbus), per ROADMAP M8 ("offline-resilience chaos testing"). Slice 2: outages of the transport and of the edge agent itself.

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
  risk, just worth noting as a design property.

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
   `ops/onboarding/install-on-node.sh` still generates units without it.
   The buffer is appended without `fsync`, so a power cut can still lose the
   last second or two.
2. **Every edge agent restart costs about 70 s of data** (`kill -9`, crash,
   deployment). The backend admits a new instance only when the previous
   heartbeat is older than `HEARTBEAT_STALE_SECONDS`, and the agent does not
   release its session on shutdown. A clean `systemctl restart` can be made
   nearly instant by releasing the session on SIGTERM; a crash still waits
   for the lease.
3. **Parts produced while the agent process is down are not counted.** All
   three counter sources take the first reading after a start as the
   baseline (`first_poll` in `s7_bridge.py`, `lastGoodCount = null` in the
   Modbus and OPC-UA sources) — which is also why a restart does not
   double-count. Inside a running process a PLC connection loss is
   caught up afterwards (the previous value is kept). Fix: persist the last
   counter values next to the buffer and diff against them on start, with a
   sanity rule for counters that went backwards (PLC reset) and a limit on how
   old the stored value may be (event timestamps are the time of emission,
   not of production).
4. `gpio-` and `s7-signal-source` tests had been failing since `58b141c`
   (custom status names are valid, a bridge that exits reports `down`);
   assertions updated on Oct 5. They still wait a fixed 400 ms, so they can
   fail on a loaded machine.

### Not tested yet

- `kill -9` while the buffer is not empty (the broker stopped first), and a
  full node-gate reboot — they would confirm the on-disk buffer survives.
- Postgres stopped / disk full on node-dc; network partition between the
  nodes; clock skew between the edge node and node-dc (event timestamps use
  the edge clock); an expired broker certificate.

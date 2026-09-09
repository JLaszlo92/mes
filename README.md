# MES — Walking Skeleton (Milestone M0)

This is the first runnable slice of the MES described in `PRD.md` and
`ROADMAP.md` (both in the project's docs, not this repo) — Milestone M0
from the roadmap: one simulated machine's signal flowing edge → cloud →
screen, surviving a simulated network drop with zero data loss.

## What's here

A pnpm monorepo with four packages:

- **`packages/shared`** — the structured event contract (PRD Section 7):
  `MachineEvent` (production counts, machine status) and the MQTT topic
  naming convention, imported by both the edge agent and the backend so a
  change to the contract is a compile error in both places, not a silent
  mismatch.
- **`packages/edge-agent`** — simulates a machine's discrete signals (good/
  scrap pulses, running/down status) and publishes them over MQTT, with a
  durable local buffer so nothing is lost if the connection drops. See
  "Why an application-level ack" below — this is the one piece of the
  skeleton that took real iteration to get right.
- **`packages/backend`** — a Fastify server that subscribes to machine
  events over MQTT, persists them to Postgres, keeps an in-memory
  "current state per machine" view, and pushes live updates to dashboard
  clients over WebSocket.
- **`packages/frontend`** — a minimal React dashboard proving the whole
  pipeline: live status + good/scrap counts, updating in real time.

## Stack decisions made while building this

A few decisions got made concretely while scaffolding rather than staying
abstract:

**TypeScript end-to-end** (Node edge agent, Fastify backend, React
frontend) rather than splitting languages — for one or two people
maintaining the whole system, one language and one shared types package
across every process is worth more than any per-service framework
advantage. The event contract in `packages/shared` is the payoff: the
compiler catches a schema mismatch between edge and cloud before it ships.

**Plain `pg` instead of an ORM.** Prisma was the original plan, but its
`postinstall` needs to download native query-engine binaries from
`binaries.prisma.sh` — which turned out to be blocked in the sandbox this
was built in, and more importantly is exactly the kind of external
dependency an IT/OT team might block on a real factory network (see PRD
Section 8.2's network-segmentation expectations). A hand-written,
idempotent SQL migration (`packages/backend/sql/001_init.sql`) plus the
plain `pg` driver has zero build-time network dependencies and is fully
transparent — there's no ORM magic for a solo maintainer to keep a model
of in their head. Revisit this if schema churn gets painful enough to
justify a real migration tool.

**An application-level acknowledgment, not just MQTT's own QoS.** This is
the one real bug this skeleton caught during its own verification, worth
recording in detail:

### Why an application-level ack

The first version of the edge agent trusted MQTT's QoS1 publish
acknowledgment as proof that an event was safely delivered, and cleared
its local buffer once that ack came back. Running the M0 "survives a
network drop" drill — kill the broker, let events buffer, restart the
broker, confirm zero loss — turned up a real gap: **MQTT's ack only proves
the *broker* received the publish, not that the backend's subscription was
active yet.** Right after a reconnect, the edge agent's publisher and the
backend's subscriber both race to re-establish their connections
independently; if the edge agent's publish reaches the broker before the
backend's `SUBSCRIBE` has been processed, the broker has no one to deliver
to and the message is gone — silently, with the publisher having already
received a successful ack.

In one drill this dropped 12 events with no error anywhere. That directly
contradicts the PRD's "data collected on the shop floor should never be
silently lost," so it got fixed rather than documented as a known
limitation:

1. The backend now connects with a stable `clientId` and `clean: false`
   (a persistent broker session), so on reconnect its subscriptions are
   restored as part of the `CONNECT` handshake itself — no separate
   `SUBSCRIBE` round-trip for a publisher to race ahead of.
2. The backend publishes an explicit ack (`mes/machines/{id}/acks`) once
   an event is durably written to Postgres — proof of actual end-to-end
   delivery, not just broker receipt.
3. The edge agent keeps every event in its local buffer until *that* ack
   arrives, and retries publishing anything still unacked on a fixed
   interval (independent of connect/reconnect events) — so even a broker
   restart that wipes persistent sessions entirely gets caught by the next
   retry sweep, not just the reconnect handler.
4. Retried (duplicate) publishes are safe because the backend already
   de-duplicates on `source_event_id`.

Re-running the same kill-the-broker drill afterward confirmed zero events
lost across 31 generated, 12 of them buffered through the outage — see
"Verifying it yourself" below to reproduce.

## Running it locally

You need Postgres and an MQTT broker. `docker-compose.yml` gives you both
if you have Docker; this skeleton was built and verified in a sandbox
*without* Docker, running Postgres and Mosquitto natively instead — either
works, nothing here depends on containers specifically.

```bash
# 1. infrastructure (native example — see docker-compose.yml for the container path)
createuser mes --pwprompt   # or: docker compose up -d
createdb mes_dev -O mes
mosquitto -p 1883 &

# 2. install
pnpm install

# 3. run each package in its own terminal
DATABASE_URL="postgresql://mes:<password>@127.0.0.1:5432/mes_dev" pnpm dev:backend
pnpm dev:edge-agent
pnpm dev:frontend   # http://localhost:5173
```

The backend runs its schema migration automatically on startup. The
frontend defaults to `ws://localhost:3001/ws`; override with
`VITE_BACKEND_WS_URL` if you're running the backend elsewhere.

## Verifying it yourself

With all three running, `curl http://localhost:3001/api/machines` should
show the simulated machine's live counts, and the dashboard should update
without a page refresh. To reproduce the network-drop drill:

```bash
pkill mosquitto        # simulate an outage
# watch packages/edge-agent's logs: events start buffering locally
sleep 15
mosquitto -p 1883 &    # recover
# watch the buffer drain (buffer file path is $BUFFER_FILE_PATH,
# defaults to /tmp/mes-edge-agent-buffer.ndjson) and the dashboard catch up
```

## Testing against real hardware — the 3-Pi rig

Setting up three blank Raspberry Pis from scratch (flashing SD cards,
first boot, SSH access)? Start with `docs/pi-hardware-setup.md`.

`SignalSource` has two real-machine-connection implementations now,
alongside the simulator, both exercised on a 3-Raspberry-Pi bench rig
(one Pi standing in for a machine, one running the edge agent, one running
the backend):

- **`S7SignalSource`** (`SIGNAL_SOURCE=s7`) — polls a Siemens S7 PLC (or
  `plc-simulator/plc_simulator.py`'s stand-in for one) over the network.
  **No physical wiring at all** — just two Pis on the same network. See
  `docs/pi-test-rig-s7-mode.md`. Start here for a fast first result.
- **`GpioSignalSource`** (`SIGNAL_SOURCE=gpio`) — reads real discrete GPIO
  input pins, physically wired between two Pis. See `docs/pi-test-rig.md`.
  Do this once the S7 mode is working, if you want to test the
  physical-wiring path too.

Either way, everything else in this README applies unchanged.

## What M1 adds next

Per `ROADMAP.md`: real protocol adapters (OPC-UA, Modbus, and the discrete
digital-I/O module described in PRD Section 5.5) alongside the simulator —
`SignalSource` in `packages/edge-agent/src/signal-sources/` is the
extension point, one new class and one line in `index.ts`. It also adds
the TimescaleDB hypertable conversion once event volume justifies it (the
schema in `sql/001_init.sql` was written so that's additive, not a
rewrite), and the fuller production-counting/OEE module this skeleton only
sketches the data path for.

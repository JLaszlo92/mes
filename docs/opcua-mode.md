# OPC-UA signal source

Mirrors the S7 mode's role: a way to exercise the OpcUaSignalSource
without wiring anything, either against the bundled simulator or a real
OPC-UA-capable PLC/controller later.

## Components

- `opcua-simulator/opcua_simulator.js` — plays "the machine". Pure
  Node.js (unlike the Python-based S7/GPIO simulators) because
  `node-opcua` is a mature client AND server library — no need for a
  separate-language bridge. Exposes three nodes: `ns=1;s=GoodCount`,
  `ns=1;s=ScrapCount`, `ns=1;s=Status`.
- `packages/edge-agent/src/signal-sources/OpcUaSignalSource.ts` — polls
  those three nodes on a fixed interval and diffs the two counters
  against their previous reading, the same poll-and-diff shape as
  S7SignalSource. No Python bridge — talks to the network directly via
  `node-opcua`.

## Running by hand

```bash
# on the node playing "the machine"
cd opcua-simulator
node opcua_simulator.js

# on the edge-agent node
cd packages/edge-agent
SIGNAL_SOURCE=opcua \
OPCUA_ENDPOINT_URL="opc.tcp://<simulator-host>:4334/mes-simulator" \
MACHINE_ID=opcua-rig-01 \
MQTT_URL=mqtt://<backend-host>:1883 \
node dist/index.js
```

## Gotcha: alternateHostname

`node-opcua`'s server advertises its own hostname in its endpoint list by
default, not the IP a remote client connects with. A client connecting by
IP (as opposed to hostname) will fail with "Cannot find suitable
endpoints in available endpoints" unless the server is told to also
accept that IP:

```js
const server = new OPCUAServer({
  // ...
  alternateHostname: ["<simulator's actual IP>"],
});
```

## Running as a systemd service

Two units, one per node — see `mes-opcua-simulator.service` (simulator
node) and `mes-edge-agent-opcua.service` (edge-agent node) for the
current working configuration. Same `Restart=on-failure`, `RestartSec=2`,
`User=root` pattern as the S7/GPIO units. Not checked into the repo
(unit files live in `/etc/systemd/system/` on each node, not in `~/mes`)
— this doc is the record of what they contain.
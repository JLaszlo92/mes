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
scripts/deploy-edge-agent.sh edge-agent-v5
```

Or, to deploy whatever the newest tag is without looking it up:

```bash
scripts/deploy-edge-agent.sh --latest
```

The script checks out the tag, rebuilds `packages/edge-agent`, and
restarts every edge-agent systemd service that exists on this node.

**Note:** the script's `SERVICES` list (`mes-edge-agent`, `-modbus`,
`-opcua`) does not contain `mes-edge-node`, the unit that actually runs on
node-gate, so it would not restart it. The edge node has so far been updated
by hand (v3, v4, v5):

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
use the environment default).

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
the previous version number. (Until the `SERVICES` list is fixed, do it by
hand on node-gate with `git checkout edge-agent-v<N-1>`, build, restart.)

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
backends. There is no field in the Admin → Edge nodes screen yet. More
per-node settings can be added to the same JSON object.

The legacy single-machine mode uses the same catch-up with the `MACHINE_ID`
and the environment limit.

## Release notes

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

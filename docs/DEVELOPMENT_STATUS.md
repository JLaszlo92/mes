# Development Status

**Last updated:** September 23, 2026

## Where things stand

**Phase 1 (M0–M8) is fully complete.** M9 (live pilot on a real Emlid
machine) has not started yet — the team is currently doing a "node-dc
polishing" pass on the existing modules before picking the actual pilot
machine, per an explicit decision to harden the platform first.

The repo (`JLaszlo92/mes`, private GitHub) is a TypeScript monorepo run
across three Proxmox LXC nodes: node-dc (`.141`, backend + frontend +
Postgres + Mosquitto), node-gate (`.142`, edge agent), node-sim (`.143`,
protocol simulators). All three are in sync on `main` as of this update.

## Milestone recap (M0–M8)

- **M0–M4**: walking skeleton, all four protocol adapters (GPIO/S7/OPC-UA/
  Modbus), production/OEE dashboard, RBAC+MFA, configurable alerts.
- **M5**: quality (machine-specific fault codes with manager
  confirm/modify/reject workflow), automatic lot-level genealogy generated
  on work-order completion (machine/operator/counts pulled from existing
  data, no manual entry), corrective-action tracking with sign-off.
- **M6**: versioned digital work instructions, tied to part name, shown
  automatically on the terminal for the active work order, every view
  logged (who/when/which version).
- **M7**: maintenance work orders (parts/labor logging), preventive
  maintenance scheduling (calendar / usage-hours / part-count triggers,
  auto-resets on completion, not creation), "Create ticket" buttons on
  alerts and confirmed fault reports (downtime-reason integration).
- **M8**: systematic chaos-testing of all four signal sources (see "Known
  gaps" below for what this found), git-tag-based staged/reversible
  edge-agent releases (`scripts/tag-edge-agent-release.sh`,
  `scripts/deploy-edge-agent.sh --latest|--rollback`), and a frank
  self-review against the IEC 62443 SL2 baseline
  (`docs/SECURITY_REVIEW.md` — the honest headline: no TLS anywhere yet,
  no automated Postgres backups, no incident-response document; these are
  the top three things to fix before any external pilot).

Two purpose-built control panels exist for the simulators, useful for any
future testing: the S7 simulator's web panel (`:8080`, pre-existing,
richer than expected — fault injection, burst mode, simulated PLC
disconnect) and a now-matching Modbus control panel (`:5021`, built this
cycle — configurable cycle time/scrap rate/downtime, manual force-down/
force-running, reset counters).

## Today's "node-dc polishing" session — what got built

This was a single very long, very thorough session. In rough order:

1. **Audit log date-range filtering + pagination** (24h/7d/30d/all
   presets, "load more"). Along the way, found and fixed a real,
   pre-existing bug: the `/api/shifts/summary` route had gone missing
   from `server.ts` entirely (import still there, route body gone) —
   nobody had noticed because the dashboard's WebSocket happened to still
   be showing cached data.

2. **Custom machine statuses with OEE classification**
   (`machine_status_definitions` table). `running` and `down` stay
   built-in; any other status name (global or per-machine) now gets
   tagged `counts_as_down` or `excluded` (planned, no OEE impact).
   `idle`→`counts_as_down` and `changeover`→`excluded` were migrated in
   as the new defaults — the changeover reclassification is a genuine OEE
   accuracy improvement over the old hardcoded behavior. Required
   loosening `MachineStatusValue` in `packages/shared` from a fixed
   4-value enum to `z.string()`.

3. **Configurable status source per machine**:
   - **Signal-presence mode** (`SignalPresenceWatchdog.ts`): infers
     running/down purely from whether `production_count` events are
     arriving, with a configurable no-signal timeout. Deliberately
     implemented **at the edge**, not the backend — a backend-side
     staleness check would produce false "down" readings during a
     network blip, exactly the class of bug M8's chaos testing had just
     found and fixed elsewhere.
   - **Production gate** (`ProductionGate.ts`): a toggle (default on) for
     whether production counts are accepted while the dedicated status
     bit reports "down" — off means a stopped machine's sensor noise
     doesn't get counted as real output.
   - Both are protocol-agnostic wrappers around any `SignalSource`.
   - **Not yet done**: a secondary status bit supplying a custom status
     name when the primary running-bit is off. Deliberately deferred —
     it's protocol-specific (a Modbus register vs. an OPC-UA node ID vs.
     an S7 DB offset vs. a GPIO pin all look completely different) and
     would need building four times.

4. **Edge-node registry** — the biggest single change of the day.
   Previously every edge-agent instance was one systemd service per
   machine, hand-configured via SSH + env vars. Now:
   - `edge_nodes` + `edge_node_channels` tables: **one edge-node can carry
     any number of channels (machines)**, each with its own protocol,
     connection config, and status-mode settings — added specifically
     because the original single-machine-per-node design didn't match
     what was actually asked for.
   - Each edge-node gets a unique secret token (shown once, only its
     SHA-256 hash stored). An edge-agent process "claims" its
     configuration from the backend using that token.
   - **Session-lease duplicate protection**: claiming records a fresh
     session ID; a second claim attempt with the same token is **rejected
     outright** (not auto-evicted) if the previous session heartbeated
     within the last 90 seconds — guarantees at most one live instance
     per registered node.
   - Heartbeat every 30s; the admin panel shows online/offline derived
     from heartbeat staleness.
   - The edge-agent (`index.ts`) now has two paths: if `EDGE_NODE_TOKEN`
     is set, it claims its channel list from the backend and runs
     multiple channels (each with its own MQTT topic/buffer/SignalSource)
     over one shared MQTT connection; if not set, it falls back to the
     **original single-machine env-var behavior verbatim** — a
     deliberate compatibility path so existing deployments keep working
     during migration.
   - **This was completed and proven, not just built**: the three
     simulator rigs that had been running as three separate systemd
     services (`mes-edge-agent`/S7, `mes-edge-agent-modbus`,
     `mes-edge-agent-opcua`) were migrated live into one registered
     edge-node (`mes-edge-node.service`) with three channels, and
     confirmed working end-to-end (all three machines still counting,
     node showing online in the admin panel). The three old services are
     stopped and disabled, not deleted, in case of rollback need.

## Known gaps surfaced this session (real findings, not guesses)

- **The `buildSignalSource`/`buildInnerSignalSource` naming-swap bug**:
  while adding the signal-presence wrapper, the two functions ended up
  with swapped names and one had an accidental self-recursive dead-code
  call. The wrapping silently never happened — no crash, no error, just
  quietly wrong behavior — until debug print statements traced it. Worth
  remembering: **a function that is provably never called is invisible to
  every test except deliberately checking call order**, and this
  particular class of bug produces no compiler error and no runtime
  error.
- **`node-opcua`'s `session.read()` does not reject on connection loss** —
  it silently queues requests forever while node-opcua reconnects
  underneath, and combined with a naive `setInterval` this caused an
  unbounded pending-request pile-up (node-opcua's own "sending multiple
  requests simultaneously" warning). Fixed with a `pollInFlight` guard
  plus a manual timeout that surfaces a stuck read as a "down" status.
- **Modbus and S7 had no reconnection/down-reporting logic at all**
  originally — found via M8's chaos testing, both fixed (see M8 recap
  above and `docs/CHAOS_TEST_FINDINGS.md`).
- **`ProcessBridgeSignalSource`** (shared base for GPIO/S7) didn't handle
  an unexpected child-process exit — no synthetic "down" event, no
  respawn. Fixed: emits "down" once per outage, respawns after a 5s
  delay, retried indefinitely.

## What's next (in priority order, per today's planning)

The "node-dc polishing" list, in the order agreed today:

1. ~~Audit log filtering~~ [done]
2. ~~Custom statuses + OEE classification~~ [done]
3. ~~Status source config (signal-presence, production gate)~~ [done] —
   **except** the secondary-status-bit piece, still open, protocol-specific
4. ~~Edge-node registry (A: registry+UI, B: heartbeat, C: live config +
   migration)~~ [done] — all three parts done and proven on real running
   infrastructure
5. **Retroactive downtime-reason capture** — when a signal-presence-mode
   or status-bit down period is detected, let the operator (terminal) or
   a supervisor (dashboard) retroactively pick a reason. Plan: reuse the
   existing M5 fault-code system rather than building new machinery —
   this hasn't been scoped in detail yet.
6. **Work-order production-quantity tracking** — this is the deferred
   "extend the event schema to carry `workOrderId`" work flagged back in
   M2/M7 as invasive. Needed for: remaining-quantity countdown on the
   terminal, auto-complete vs. manual-confirm-on-target-reached policy per
   work order, and an overproduction-counts-or-not toggle.
7. **Terminal refinements**: collapse historical work orders behind a
   button (don't show everything by default), show the machine's
   current-shift good/scrap/OEE inline on the terminal. Both
   straightforward, independent of #6.
8. **Historical reporting**: time-bucketed charts (hour/shift/day/week/
   month) for counts/status/cycle-time/OEE, plus fast work-order history
   lookup. Deliberately sequenced *after* #6, since work-order history
   without the event linkage would be half-useful.

After the polishing list: **M9** (pick the real target Emlid machine —
still an open decision — connect it via whichever protocol it exposes,
onboard real users, and the same live feedback/bug-fix loop the ROADMAP
always called for this milestone). The security review's top three items
(TLS everywhere, automated backups, an incident-response doc) are also
worth doing before any pilot involving real production data, independent
of the milestone numbering.

## Practical notes for whoever (or whatever session) picks this up

- All three nodes are pushed and pulled to the same commit as of this
  writing — always `git pull` before editing anywhere, this session hit
  the "distant branches" merge prompt (`git config pull.rebase false`)
  and the VS Code askpass hijack (`unset GIT_ASKPASS
  VSCODE_GIT_ASKPASS_NODE VSCODE_GIT_ASKPASS_MAIN` before `git push`)
  enough times that both are now routine, not surprising.
- `mes-edge-node.service` on node-gate is the new, single, token-based
  service carrying all three simulator channels. The old
  `mes-edge-agent`/`mes-edge-agent-modbus`/`mes-edge-agent-opcua` units
  still exist on disk but are stopped+disabled — don't `systemctl start`
  them without first stopping `mes-edge-node`, or two processes will
  publish to the same machine IDs simultaneously.
- The edge-node's secret token lives in
  `/etc/systemd/system/mes-edge-node.service`'s `EDGE_NODE_TOKEN=`
  line on node-gate — if it's ever lost, use "New token" in the admin
  panel's Edge nodes list and update the unit file (this invalidates the
  old token immediately).
- `rm -rf dist *.tsbuildinfo` before rebuilding is still the fix whenever
  behavior doesn't match code after a `pnpm run build` — hit this again
  today (the naming-swap bug above).

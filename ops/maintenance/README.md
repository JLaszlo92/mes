# Maintenance scripts

## `mes-purge-machine-history.sh` — delete a machine's history

For clearing test data before the pilot (or when a test machine becomes a
real one). Deletes the **history** of the named machines — events, downtime
periods, production counts, alerts, fault reports (and their corrective
actions), lots, work-order assignments, maintenance work orders — and keeps
the machines themselves and their **configuration** (fault codes, status
definitions, alert rules, preventive schedules, edge channels, terminal UI
membership). `audit_log` is never touched.

```bash
install -m 755 /root/mes/ops/maintenance/mes-purge-machine-history.sh /usr/local/bin/

mes-purge-machine-history.sh s7-test0001 test-1           # dry run: shows row counts, deletes nothing
systemctl start mes-backup.service                        # a backup < 1 h old is required for --apply
mes-purge-machine-history.sh --apply s7-test0001 test-1   # asks you to type 'purge'
```

Safeguards:

- **Dry run by default**; `--apply` deletes, after an interactive
  confirmation (`--yes` for non-interactive use).
- Tables are handled by **explicit lists** (`HISTORY`, `CONFIG` at the top
  of the script). If the schema has a `machine_id` table that's on neither
  list, the script refuses to run — classify new tables there first, so a
  new configuration table can never be purged by accident.
- Refuses `--apply` without a successful backup in the last hour
  (`job_status`), and for machines that received data in the last 5
  minutes (a running simulator / edge agent would refill it — stop it
  first, or pass `--allow-live`).
- All deletes run in **one transaction**: if anything fails (e.g. a foreign
  key), nothing is deleted.
- Writes a `machine_history_purged` audit entry (machines, row count, who
  ran it) and restarts `mes-backend` so in-memory machine state reloads.

To remove a machine entirely, purge its history first, then delete or
deactivate it in the Machine registry.

### Before the pilot

Decide per machine:

- **Pilot machine gets a new id** → nothing to delete: set the test
  machines inactive in the registry and stop the simulators on node-sim.
  Reversible; test history stays available.
- **A test machine becomes a real one** (e.g. `s7-rig-01` "Press 3") →
  stop its simulator, take a backup, purge that machine's history, keep its
  configuration.

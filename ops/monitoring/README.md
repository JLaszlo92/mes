# Certificate expiry monitoring (node-dc)

`mes-cert-check.sh` runs daily from `mes-cert-check.timer`, checks every
certificate this machine uses and records the result in the `job_status` table
(`cert_expiry`). The backend (`cert-health-evaluator.ts`) turns a failure into a
MES system alert, and also alerts when no check has run for 3 days.

Install (as root, from the repo root):

```bash
bash ops/monitoring/install-cert-check.sh
```
Run it **before** deploying the backend evaluator
(`ops/maintenance/apply-cert-health-wiring.sh`).

Look at the current state any time:

```bash
mes-cert-check.sh --no-record        # prints the table, writes nothing
systemctl list-timers mes-cert-check.timer
journalctl -u mes-cert-check.service -n 20 -o cat
```

- Default threshold: 30 days (`WARN_DAYS` in the unit via a drop-in, if needed).
- Add certificates: one `label|/path/to/cert.pem` per line in
  `/etc/mes/cert-check.paths` (labels: letters, digits, `.`, `_`, `-`).
- After a renewal nothing has to be done; the next run reads the new file.
  Run `systemctl start mes-cert-check.service` to clear the alert sooner.
- Certificates of other machines (edge nodes) are not visible from here; the
  admin laptop tracks them: `mes-ca.sh status` / `mes-ca.sh ics`
  (`ops/ca/README.md`).

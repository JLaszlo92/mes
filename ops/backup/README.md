# MES Postgres backups (node-dc → AWS S3)

Daily `pg_dump` of the `mes` database, kept locally (last 3) and uploaded
to S3. Retention is enforced by **S3 lifecycle rules**, not by the script:
the IAM user on node-dc can write and read backups but **cannot delete
them**, so a compromised node-dc cannot wipe its own backups.

| Prefix | Written | Kept |
|---|---|---|
| `daily/` | every day | 14 days |
| `weekly/` | Sundays (server-side copy) | 60 days |
| `monthly/` | 1st of the month (server-side copy) | 400 days |

Files: `mes-backup.sh` (backup), `mes-restore-test.sh` (restore drill),
`mes-backup.service` + `mes-backup.timer` (daily 02:30 UTC),
`backup.env.example`, `iam-policy.json`, `lifecycle.json`.

The scripts only use the S3 API. For customers whose data may not leave
the site, set `S3_ENDPOINT_URL` to an on-prem S3-compatible store (e.g.
MinIO) — no code change needed.

## 1. AWS setup (console, once)

1. **Bucket** — S3 → Create bucket.
   - Region: **eu-central-1 (Frankfurt)** — keeps backups in the EU.
   - Block *all* public access: **on** (default).
   - Bucket versioning: **Enable** — an overwrite keeps the previous
     version, so even a `PutObject` can't destroy a backup.
   - Default encryption: SSE-S3 (default).
2. **Lifecycle** — bucket → Management → Create lifecycle rule, one per row
   of `lifecycle.json` (prefix + expiration days, plus one rule for all
   objects that expires noncurrent versions after 30 days and aborts
   incomplete multipart uploads after 7 days). Or, with an admin CLI:
   `aws s3api put-bucket-lifecycle-configuration --bucket <bucket> --lifecycle-configuration file://lifecycle.json`
3. **IAM user** — IAM → Users → Create user `mes-backup-node-dc`, no
   console access. Add an inline policy: paste `iam-policy.json` with
   `BUCKET_NAME` replaced by the bucket name. No other permissions.
4. **Access key** — the user → Security credentials → Create access key →
   "Application running outside AWS". Keep the two values for step 2.3;
   don't paste them into a chat, ticket or doc.

## 2. node-dc setup (once)

```bash
# 2.1 AWS CLI
apt install -y awscli
aws --version

# 2.2 scripts + units
cd /root/mes/ops/backup
install -m 755 mes-backup.sh mes-restore-test.sh /usr/local/bin/
install -m 644 mes-backup.service mes-backup.timer /etc/systemd/system/

# 2.3 credentials (stored in /root/.aws/, 0600)
aws configure --profile mes-backup     # key, secret, region eu-central-1, output json

# 2.4 config (no secrets in it)
install -m 600 backup.env.example /etc/mes/backup.env
nano /etc/mes/backup.env                # set S3_BUCKET

# 2.5 access check — should list nothing (empty bucket), without an error
aws s3 ls s3://<bucket>/ --profile mes-backup
```

## 3. First run and restore drill

```bash
systemctl daemon-reload
systemctl start mes-backup.service       # first backup, runs in the foreground
journalctl -u mes-backup -n 30 --no-pager -o cat
mes-restore-test.sh                      # downloads the latest daily/ and restores it
```

`mes-restore-test.sh` restores into a temporary `mes_restore_test`
database, compares tables and row counts with the live one, and drops it.
Row counts differ slightly (the live DB kept writing) — that's expected.
It must end with `restore test PASSED`.

Then enable the schedule:

```bash
systemctl enable --now mes-backup.timer
systemctl list-timers mes-backup.timer
```

## Operations

- **Status**: `systemctl list-timers mes-backup.timer`,
  `systemctl status mes-backup.service`, `journalctl -u mes-backup`.
- `pg_dump: warning: there are circular foreign-key constraints …` on
  TimescaleDB catalog tables is normal.
- **Restore drill**: run `mes-restore-test.sh` at least monthly and after
  any Postgres/TimescaleDB upgrade.
- **Real restore** (disaster): create an empty `mes` database owned by
  `mes`, then as postgres: `CREATE EXTENSION timescaledb;`
  `SELECT timescaledb_pre_restore();`, `pg_restore -d mes < <dump>`,
  `SELECT timescaledb_post_restore();`, `ANALYZE;`. The target must run
  the **same TimescaleDB version** as the backup source.
- Rotating the AWS key: create a new key for the IAM user,
  `aws configure --profile mes-backup`, run a manual backup, delete the old key.
- **Alerting**: every run (success *and* failure) writes its result to
  the `job_status` table (`name = 'db_backup'`, with the failing step on
  failure and file/size/sha256 on success). The backend's
  `backup-health-evaluator.ts` checks it every 5 minutes and raises a
  **System** alert in the MES Alerts view if the last run failed, or if
  there has been no successful backup for 26 hours — which also catches
  a timer that never ran. The alert resolves itself once a backup
  succeeds. Check it by hand:
  `psql -h localhost -U mes mes -c "SELECT * FROM job_status;"`
- **Limit**: if node-dc itself is down, nothing on node-dc can alert.
  Covering that needs an external heartbeat check (not set up).

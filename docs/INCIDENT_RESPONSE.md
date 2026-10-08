# Incident Response

**Status:** Draft v0.2 — October 1, 2026. Fill in every `‹…›` placeholder
before the first paying customer (PRD 8.8), and review this document at
least once a year and after every incident.

**Scope:** the MES as deployed today — node-dc (backend, frontend,
PostgreSQL, Mosquitto), node-gate (edge agent), node-sim (simulators),
the S3 backup bucket, and the GitHub repository. Written for a small team:
one person may hold several roles below.

> This document is operational guidance, not legal advice. Notification
> duties (GDPR, NIS2 and their Hungarian implementation, customer
> contracts) must be confirmed with ‹legal contact› — see section 7.

## 1. What counts as an incident

Report anything below — **when in doubt, report it**. A false alarm costs
minutes; an unreported incident can cost the customer relationship.

**Security**

- Unexpected logins, admin actions nobody recognizes, or `login_locked` /
  `mfa_locked` bursts in the audit log.
- A secret exposed: the Postgres password, an AWS key, an edge-node token,
  a session token (e.g. pasted into a chat, ticket, screenshot or commit).
- Unknown clients on the MQTT broker, or machine data that doesn't match
  what the machine is doing (possible injected events).
- Malware, ransomware, or unexplained changes on any node.
- A lost or stolen device with access (laptop, terminal tablet).

**Operational**

- Data loss or corruption; a backup alert (`backup_health`) that doesn't
  resolve itself after the next run.
- MES unavailable while production runs, beyond a few minutes.
- The edge agent's offline buffer growing without draining.

## 2. Severity

| Level | Definition | Examples | Response |
|---|---|---|---|
| **SEV1** | Confirmed compromise, data loss, or production impact | Unauthorized admin access; ransomware; database lost; attacker publishing machine events | Immediately, any time |
| **SEV2** | Likely compromise or serious degradation, contained | Exposed secret not yet known to be used; MES down but shop floor unaffected (edge buffers); backups failing > 24 h | Within 4 working hours |
| **SEV3** | Suspicious but unconfirmed, or minor | Isolated failed-login burst; single failed backup that recovers | Next working day |

Raise the level as soon as new facts justify it; lowering it needs a
written reason in the incident log.

## 3. Roles and contacts

| Role | Responsibility | Primary | Backup |
|---|---|---|---|
| Incident lead | Owns the incident end to end, decides severity, keeps the log | ‹name, phone› | ‹name, phone› |
| Technical responder | Containment, evidence, recovery on the nodes | ‹name, phone› | ‹name, phone› |
| Customer contact | All communication with the customer | ‹name, phone› | ‹name, phone› |
| Legal / data protection | Notification duties, regulators | ‹name, email› | ‹name, email› |
| Emlid IT / OT | Network, firewall, Proxmox host | ‹name, phone› | ‹name, phone› |

**Reporting channel:** ‹phone number / email / chat channel› — reachable
outside working hours for SEV1.

## 4. First hour

1. **Open an incident log** (a dated document or ticket). Write down
   *everything* with timestamps — what was seen, who did what. This log
   is the basis for the review and for any notification.
2. **Set the severity** (section 2) and call the people in section 3.
3. **Preserve evidence before changing anything** (section 5.1) — unless
   an attacker is actively causing damage, then contain first (5.2).
4. **Contain** (5.2). Prefer steps that keep production running: the edge
   agent buffers locally, so the backend and broker can be stopped without
   losing machine data.
5. **Decide on customer notice** (section 6) — for SEV1 within the first
   hours, not after the fix.

## 5. Playbooks

### 5.1 Preserve evidence

Copy these off the node before restarts, rotations or restores:

```bash
T=$(date -u +%Y%m%dT%H%M%SZ); mkdir -p /root/incident-$T && cd /root/incident-$T
journalctl -u mes-backend --since "-7 days" -o json > mes-backend.journal.json
journalctl -u mosquitto --since "-7 days" -o json > mosquitto.journal.json
cp -a /var/log/nginx nginx-logs; cp -a /var/log/mosquitto mosquitto-logs
psql -h localhost -U mes mes -c "\copy (SELECT * FROM audit_log WHERE occurred_at > now() - interval '30 days' ORDER BY occurred_at) TO 'audit_log.csv' CSV HEADER"
psql -h localhost -U mes mes -c "\copy (SELECT key, failures, window_started_at, locked_until FROM auth_throttle) TO 'auth_throttle.csv' CSV HEADER"
last -F > logins.txt; ss -tnp > connections.txt
sha256sum * > SHA256SUMS
```

Also run `systemctl start mes-backup.service` to take a fresh database
snapshot, and keep the most recent pre-incident backup in S3 (the bucket
is versioned; lifecycle deletes dailies after 14 days — extend it if the
investigation needs older ones). Take a Proxmox snapshot of affected
nodes if the host is trusted.

### 5.2 Containment

| Situation | Action |
|---|---|
| Suspected account compromise | Deactivate the user (`UPDATE users SET is_active = false WHERE email = '…'`) and end all sessions: `DELETE FROM sessions;` (everyone signs in again — MFA still required for admin/manager) |
| Postgres password exposed | Rotate: procedure in `DEVELOPMENT_STATUS.md` → "Configuration and secrets" |
| AWS backup key exposed | IAM → user `mes-backup-node-dc` → deactivate the key, create a new one, `aws configure --profile mes-backup` on node-dc, run a backup. The key can't delete backups, but it can read them |
| Edge node compromised | Admin → Edge nodes → regenerate its token (the old one stops working); `systemctl stop mes-edge-node` on the node; the new token goes into `/etc/mes/edge-node.env` only when the node is trusted again. Then cut its MQTT access: remove its `user node-gate` block from `/etc/mosquitto/acl.conf` and `systemctl reload mosquitto` (its device certificate stays valid until expiry, but its publishes are dropped), and block the node at the network level too |
| Device certificate or key lost or stolen | Remove its `user <CN>` block from `/etc/mosquitto/acl.conf` and `systemctl reload mosquitto`; the device can still connect but can publish and receive nothing. Issue a new certificate under a new name (`mes-ca.sh issue-device`), copy it, add the ACL block. A CRL is not set up (`SECURITY_REVIEW.md` 8.3) |
| Device CA root key lost or exposed | Anyone with the key can mint devices that Mosquitto accepts. Build a new device CA (`mes-ca.sh init-device`), re-issue every device certificate (`backend`, `node-gate`, `admin-laptop`), replace `/etc/mosquitto/certs/device-ca.crt`, restart Mosquitto, restart the backend and the edge node. Check the broker log and `audit_log` for events from unknown sources |
| Server CA root key lost or exposed | Treat every certificate as untrusted: build a new CA (`ops/ca/mes-ca.sh init`), re-issue the `mosquitto`, `proxy` and `postgres` certificates, distribute the new `ca.crt` to node-dc, node-gate, terminal tablets and browsers, restart/reload the services. Until then anyone with the key can impersonate the broker, the proxy and the database |
| Server certificate expired or about to | Re-issue with `mes-ca.sh issue` (move the old directory away first), copy `cert.pem`/`key.pem`, then: Mosquitto → restart (edge agents reconnect on their own); nginx → `nginx -t && systemctl reload nginx`; Postgres → `systemctl reload postgresql@17-main`. An expired broker certificate stops every edge agent |
| Unknown MQTT publisher | Publishers need a device-CA certificate now (port 8884 only), so first suspect a stolen certificate or key: identify it from the broker log / the `machineId`s it publishes, then see the row above. If it must stop at once: `systemctl stop mosquitto` on node-dc; edge agents buffer until it's back |
| Backend or node compromised | Isolate the node at the network (Emlid IT/OT); do not wipe it before evidence is copied |
| Brute-force attempts | Login throttling locks automatically; review `login_locked` entries; block the source IP at the firewall if it persists |

### 5.3 Recovery

- **Database restore:** `ops/backup/README.md` → "Real restore". Verify
  first with `mes-restore-test.sh` against the backup you intend to use.
  After a compromise, restore to a backup from *before* the first sign of
  intrusion and rotate every secret (Postgres, AWS key, edge tokens, user
  passwords).
- **Rebuild from source:** code is in GitHub (`JLaszlo92/mes`); nodes
  can be rebuilt from Debian + the repo + `/etc/mes/` (which must be
  recreated with *new* secrets, never copied from a compromised node).
  TLS certificates are re-issued from the offline CA on the admin machine
  (`ops/ca/`, `ops/proxy/`); a rebuilt node needs the public `ca.crt`
  (`/etc/ssl/mes-ca.crt`) and its own `cert.pem`/`key.pem` — never copy a
  private key from a compromised node.
- Before declaring recovery: dashboard live, backups succeeding, audit
  log writing, no open `backup_health` alert, edge buffers drained.

### 5.4 Disk full on node-dc

Measured in chaos slice 23 (Oct 8, 2026). The database stays up and refuses the writes with an SQL error; the
backend does not acknowledge the events, so **the edge nodes buffer them and nothing is lost**; the dashboard shows
no banner, `GET /health?db=1` stays 200 and the Postgres log goes silent. The `disk_space` alert (85%) is the early
warning; at 100% it may not be possible to write the alert itself. The ext4 reserve for root does **not** work inside
the LXC container, so at 100% even a root shell and editors can fail.

1. Free space at once, safest first: `journalctl --vacuum-size=50M`, `apt clean`, then the oldest dumps in
   `/var/backups/mes` (the newest dump and the S3 copies stay; 3 are kept, about 190 MB each), old logs in
   `/var/log`. Never delete anything under `/var/lib/postgresql`.
2. Check: `df -h /`, `systemctl status postgresql@17-main mes-backend`, `curl -sk https://localhost/health?db=1`,
   and that `max(created_at)` of `events` catches up with `now()` within a minute or two.
3. On the edge nodes the buffer drains by itself (`/root/buf-snap.sh` shows 0 events afterwards).
4. If the Postgres does not come back, or a PANIC about the WAL is in the log, free more space first, then
   `systemctl restart postgresql@17-main`; restore from a backup only if the cluster does not start after that
   (`ops/backup/README.md`).
5. Find the cause (`du -xh / | sort -h | tail`), fix it, and keep the free space above the alert limit.

## 6. Customer communication

- **Who:** only the customer contact (section 3) speaks to the customer.
- **When:** SEV1 — first notice within ‹X hours, agree with the customer
  contract›, even if the cause isn't known yet; updates at least
  ‹daily›. SEV2 — within ‹X› working days if customer data or production
  was affected.
- **What the first notice contains:** what happened (as far as known), when
  it was detected, what the customer's data / production exposure is,
  what we're doing, what the customer should do (e.g. change passwords),
  and when the next update comes.
- **Closing notice:** root cause, what was changed, and what we'll do to
  prevent a repeat — summarized from the review (section 8).

## 7. Regulatory and contractual notification

To be confirmed with legal before the first external customer:

- **Personal data** (the MES stores user emails and audit trails): a
  breach may need notification to the data protection authority within
  72 hours under GDPR Art. 33 — ‹legal to confirm scope and who notifies›.
- **NIS2 / Hungarian cybersecurity law:** whether Emlid or a customer is
  in scope, and the early-warning / notification timelines that follow —
  ‹legal to confirm›.
- **Customer contracts:** notification clauses and timelines —
  ‹record per customer›.

## 8. After the incident

Within ‹5› working days of closing a SEV1/SEV2:

1. Blameless review: timeline, root cause, what worked, what didn't.
2. Concrete follow-ups with owners and dates (code, config, this document).
3. Update `SECURITY_REVIEW.md` if the incident revealed a gap.
4. Keep the incident log and evidence for ‹retention period›.

## 9. Exercise

Run a tabletop exercise at least once a year and before the first pilot
customer — e.g. "an operator's password was pasted into a public chat"
and "node-dc disk is gone": walk through sections 4–6 and time a real
restore with `mes-restore-test.sh`.

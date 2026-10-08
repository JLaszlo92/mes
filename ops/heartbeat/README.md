# node-dc heartbeat (dead-man's switch)

Every alert of the MES runs on node-dc, so nothing tells you when node-dc itself is dead, cut off, or running with a
database that cannot store events. This heartbeat is the one signal that comes from **outside**: node-dc pings an
external check every minute, and the external service alarms when the pings stop.

## What is checked

`mes-heartbeat.sh` asks the local `GET /health?db=1`. Only a **200** (backend up, database answers, events can be
stored) is followed by the ping. The ping stops when:

- node-dc is off, frozen or has lost its network or internet access;
- the backend does not run (`/health` unreachable);
- the database is down (503 `database_unavailable`) or cannot store events (503 `ingestion_failing`, for example a full disk).

It does **not** replace the in-system alerts (`machine_down`, `disk_space`, `ingestion_failing`, ...). It answers the one
question they cannot: "is anybody home?".

## Setup

1. Create a check at a dead-man's-switch service (Healthchecks.io, Uptime Kuma "push" monitor, UptimeRobot heartbeat, ...).
   Suggested: expected period **1 minute**, grace time **3 to 5 minutes** (a restart of the backend or a short network
   glitch must not alarm), notification by e-mail and/or a messenger. Copy the **ping URL**.
2. On node-dc, from the repository:
   ```
   cd ~/mes && ops/heartbeat/install.sh
   nano /etc/default/mes-heartbeat        # set HEARTBEAT_URL=<the ping URL>; mode 600, root only
   systemctl enable --now mes-heartbeat.timer
   ```
   Optional `HEARTBEAT_FAIL_URL` (Healthchecks.io: the ping URL + `/fail`) makes the alarm come at once when the health check
   fails, instead of after the grace time.
3. Check: `systemctl list-timers mes-heartbeat.timer`, `journalctl -u mes-heartbeat -n 5 --no-pager`
   ("heartbeat sent") and that the check shows "up" at the service.

The ping URL is a secret (whoever knows it can fake a heartbeat): keep it in `/etc/default/mes-heartbeat` only, never in
the repository, a ticket or a chat. The script never prints it.

## Test it (once, after the setup)

- `ops/heartbeat/test-heartbeat.sh` tests the script against fake local servers (no root, no network).
- Real alarm: `systemctl stop mes-heartbeat.timer`, wait for the grace time, confirm the notification arrives, then
  `systemctl start mes-heartbeat.timer` and confirm the "recovered" message.
- Optional, with a maintenance window: `systemctl stop mes-backend` instead; the pings stop the same way (and the edge
  nodes buffer meanwhile).

## Limits

- It checks "the backend says healthy", not every part: the broker, the edge nodes and the machines are watched by the
  in-system alerts. If the broker dies alone, the heartbeat keeps going.
- A third party learns that "something pings every minute from your public address". Nothing else is sent.
- The monitoring service is a dependency of its own: choose one you trust, and keep its notification channel working.

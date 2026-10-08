#!/usr/bin/env bash
# Installs the heartbeat on node-dc. Run as root from the repository: ops/heartbeat/install.sh
# It never asks for or prints the ping URL: put it into /etc/default/mes-heartbeat yourself (mode 600).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

install -m 755 "$here/mes-heartbeat.sh" /usr/local/bin/mes-heartbeat.sh
install -m 644 "$here/mes-heartbeat.service" /etc/systemd/system/mes-heartbeat.service
install -m 644 "$here/mes-heartbeat.timer" /etc/systemd/system/mes-heartbeat.timer

if [ ! -e /etc/default/mes-heartbeat ]; then
  umask 077
  cat > /etc/default/mes-heartbeat <<'CONF'
# Ping URL of the external check (a secret!). Required.
HEARTBEAT_URL=
# Optional: pinged when /health?db=1 is not 200 (Healthchecks.io: the ping URL + /fail).
HEARTBEAT_FAIL_URL=
CONF
  chmod 600 /etc/default/mes-heartbeat
  echo "created /etc/default/mes-heartbeat (mode 600): set HEARTBEAT_URL, then: systemctl enable --now mes-heartbeat.timer"
else
  echo "/etc/default/mes-heartbeat already exists, left as it is"
fi
systemctl daemon-reload
echo "installed. The timer starts after: systemctl enable --now mes-heartbeat.timer"

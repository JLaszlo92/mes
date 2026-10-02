#!/usr/bin/env bash
# Installs the certificate check on node-dc (run as root from the repo root).
# Install this BEFORE deploying the backend's cert-health-evaluator: until the
# first check has been recorded, the evaluator reports "no check recorded yet".
set -euo pipefail
D=ops/monitoring
for f in mes-cert-check.sh mes-cert-check.service mes-cert-check.timer; do
  [[ -f $D/$f ]] || { echo "Missing $D/$f (run from the repo root)" >&2; exit 1; }
done
[[ $EUID -eq 0 ]] || { echo "Run as root" >&2; exit 1; }

install -m 0755 $D/mes-cert-check.sh /usr/local/bin/mes-cert-check.sh
install -m 0644 $D/mes-cert-check.service /etc/systemd/system/mes-cert-check.service
install -m 0644 $D/mes-cert-check.timer   /etc/systemd/system/mes-cert-check.timer
systemctl daemon-reload
systemctl enable --now mes-cert-check.timer
echo "--- first run (records the initial result) ---"
systemctl start mes-cert-check.service || true
journalctl -u mes-cert-check.service --no-pager -n 14 -o cat | cut -c1-160
echo "--- timer ---"
systemctl list-timers mes-cert-check.timer --no-pager | head -n 3

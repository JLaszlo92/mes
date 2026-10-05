#!/usr/bin/env bash
# Run on node-dc. Stops a service (mosquitto, mes-backend, ...) for N seconds, waits
# for you to take the edge buffer snapshot (buf-snap.sh on the edge node), then starts it.
#   ops/chaos/chaos-svc.sh mosquitto 120
set -euo pipefail
SVC="${1:?service name}"
SECS="${2:-120}"
echo "STOP  $SVC $(date -u +%FT%TZ)"
systemctl stop "$SVC"
sleep "$SECS"
echo "READY $(date -u +%FT%TZ)  -> run buf-snap.sh on the edge node NOW, then press Enter here"
read -r _
systemctl start "$SVC"
echo "START $SVC $(date -u +%FT%TZ)"

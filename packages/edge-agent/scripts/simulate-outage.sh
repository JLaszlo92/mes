#!/usr/bin/env bash
# Reproduces the M0 network-drop drill described in the root README: kills
# the MQTT broker, gives the edge agent time to buffer events locally, then
# restarts the broker and gives it time to flush. Run this with the backend
# and edge agent already running in other terminals so you can watch their
# logs and the dashboard react in real time.
#
# Usage: ./simulate-outage.sh [outage_seconds] [broker_port]
set -euo pipefail

OUTAGE_SECONDS="${1:-15}"
PORT="${2:-1883}"

echo "==> Killing mosquitto on port ${PORT} (simulating a network drop)…"
pkill -f "mosquitto -d -p ${PORT}" || pkill mosquitto || true

echo "==> Broker down. Watch the edge agent log — events should start"
echo "    buffering locally (BUFFER_FILE_PATH, default"
echo "    /tmp/mes-edge-agent-buffer.ndjson) instead of erroring out."
sleep "${OUTAGE_SECONDS}"

echo "==> Restarting mosquitto…"
mosquitto -d -p "${PORT}"

echo "==> Broker back up. Watch the edge agent log for 'flushing buffered"
echo "    events' / retry-sweep lines, and confirm the buffer file empties:"
echo "      watch -n1 'wc -l \${BUFFER_FILE_PATH:-/tmp/mes-edge-agent-buffer.ndjson}'"
echo "    The dashboard should catch up to the correct counts within a few"
echo "    retry-sweep cycles (4s each, see index.ts)."

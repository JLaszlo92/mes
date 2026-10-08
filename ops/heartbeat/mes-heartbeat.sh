#!/usr/bin/env bash
# Dead-man's-switch heartbeat of node-dc (ops/heartbeat/README.md).
#
# Every run asks the local backend GET /health?db=1. Only when it answers 200 (backend up, database reachable AND able to
# store events: chaos slice 23) the external heartbeat URL is pinged. When the host is down, the network is gone, or the
# backend / database is unhealthy, the ping does not happen and the external service raises the alarm after its grace
# time. This is the only monitor that still works when node-dc itself is dead.
#
# Settings come from the environment (the unit reads /etc/default/mes-heartbeat):
#   HEARTBEAT_URL        required. The ping URL of the external check. Treat it as a secret: never log or echo it.
#   HEARTBEAT_FAIL_URL   optional. Pinged when the health check fails (Healthchecks.io: "<ping url>/fail") for a faster alarm.
#   HEALTH_URL           default http://127.0.0.1:3001/health?db=1
#   HEARTBEAT_TIMEOUT    seconds per request, default 10
set -u

health_url="${HEALTH_URL:-http://127.0.0.1:3001/health?db=1}"
timeout="${HEARTBEAT_TIMEOUT:-10}"

if [ -z "${HEARTBEAT_URL:-}" ]; then
  echo "mes-heartbeat: HEARTBEAT_URL is not set (see /etc/default/mes-heartbeat)" >&2
  exit 78
fi

# Never let the URL reach the journal: curl is quiet, errors are summarised by exit code.
ping() {
  curl -fsS -o /dev/null --max-time "$timeout" --retry 2 --retry-delay 2 "$1" 2>/dev/null
}

code="$(curl -s -o /dev/null --max-time 5 -w '%{http_code}' "$health_url" 2>/dev/null || true)"

if [ "$code" = "200" ]; then
  if ping "$HEARTBEAT_URL"; then
    echo "mes-heartbeat: ok (health 200, heartbeat sent)"
    exit 0
  fi
  echo "mes-heartbeat: health 200 but the heartbeat could not be sent (network or service down?)" >&2
  exit 1
fi

echo "mes-heartbeat: UNHEALTHY (health answered '${code:-none}'), heartbeat withheld" >&2
if [ -n "${HEARTBEAT_FAIL_URL:-}" ]; then
  ping "$HEARTBEAT_FAIL_URL" || true
fi
exit 1

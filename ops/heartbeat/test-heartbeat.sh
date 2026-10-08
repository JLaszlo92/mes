#!/usr/bin/env bash
# Tests mes-heartbeat.sh against two local fake servers (health and heartbeat). Needs python3 and curl, no root.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"; trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$work"' EXIT
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$3', got '$2')"; fail=1; fi; }

cat > "$work/server.py" <<'PY'
import sys, http.server
port, code_file, log_file = int(sys.argv[1]), sys.argv[2], sys.argv[3]
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        try: code = int(open(code_file).read().strip())
        except Exception: code = 200
        open(log_file, "a").write(self.path + "\n")
        self.send_response(code); self.end_headers(); self.wfile.write(b"x")
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", port), H).serve_forever()
PY
hp=$((20000 + RANDOM % 10000)); bp=$((hp + 1))
echo 200 > "$work/health.code"; echo 200 > "$work/beat.code"; : > "$work/health.log"; : > "$work/beat.log"
python3 "$work/server.py" $hp "$work/health.code" "$work/health.log" & python3 "$work/server.py" $bp "$work/beat.code" "$work/beat.log" &
sleep 1
run() { HEALTH_URL="http://127.0.0.1:$hp/health?db=1" HEARTBEAT_URL="http://127.0.0.1:$bp/ping/SECRET" HEARTBEAT_TIMEOUT=3 "$@" "$here/mes-heartbeat.sh" >/dev/null 2>"$work/err"; echo $?; }

: > "$work/beat.log"
check "healthy: exit 0" "$(run env)" 0
check "healthy: heartbeat pinged once" "$(wc -l < "$work/beat.log" | tr -d ' ')" 1
check "healthy: the right path" "$(head -1 "$work/beat.log")" "/ping/SECRET"

for bad in 503 500; do
  echo $bad > "$work/health.code"; : > "$work/beat.log"
  check "health $bad: exit 1" "$(run env)" 1
  check "health $bad: no heartbeat" "$(wc -l < "$work/beat.log" | tr -d ' ')" 0
done
check "the secret URL is not in the error output" "$(grep -c SECRET "$work/err")" 0

echo 503 > "$work/health.code"; : > "$work/beat.log"
HEARTBEAT_FAIL_URL="http://127.0.0.1:$bp/ping/SECRET/fail" run env >/dev/null
check "fail URL is pinged when set" "$(head -1 "$work/beat.log")" "/ping/SECRET/fail"

echo 200 > "$work/health.code"; echo 500 > "$work/beat.code"; : > "$work/beat.log"
check "heartbeat service down: exit 1" "$(run env)" 1
check "the secret URL is not in the error output (heartbeat failure)" "$(grep -c SECRET "$work/err")" 0
echo 200 > "$work/beat.code"

kill %1 2>/dev/null; sleep 0.5
check "backend unreachable: exit 1" "$(run env)" 1
check "no URL set: exit 78" "$(HEALTH_URL=x HEARTBEAT_URL= "$here/mes-heartbeat.sh" 2>/dev/null; echo $?)" 78
exit $fail

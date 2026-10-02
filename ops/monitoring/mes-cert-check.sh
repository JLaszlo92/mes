#!/usr/bin/env bash
# Daily certificate expiry check for node-dc (mes-cert-check.timer).
#
# Checks the certificates this machine actually uses and writes the result to
# the job_status table (name: cert_expiry), exactly like mes-backup.sh does for
# the backup. The backend's cert-health-evaluator.ts raises a system alert in
# the MES when the result is a failure, or when no check has run for 3 days
# (dead man's switch: it also catches a timer that stopped running).
#
#   mes-cert-check.sh [--no-record]      --no-record: print only, no database write
#
# Env: WARN_DAYS (default 30). Extra certificates: one "label|/path/cert.pem"
# per line in /etc/mes/cert-check.paths. Test hook: MES_CERT_CHECK_NOW (epoch).
# Exit code 1 when something is expiring/unreadable, so `systemctl --failed`
# shows it as well.
set -Eeuo pipefail
umask 077

WARN_DAYS="${WARN_DAYS:-30}"
EXTRA_FILE="${CERT_CHECK_EXTRA:-/etc/mes/cert-check.paths}"
DB_NAME=mes
JOB=cert_expiry
record=1
[[ "${1:-}" == "--no-record" ]] && record=0
[[ "$WARN_DAYS" =~ ^[0-9]+$ ]] || { echo "WARN_DAYS must be a whole number" >&2; exit 2; }

CERTS=(
  "mosquitto-server|/etc/mosquitto/certs/cert.pem"
  "server-ca-root|/etc/mosquitto/certs/ca.crt"
  "device-ca-root|/etc/mosquitto/certs/device-ca.crt"
  "nginx-proxy|/etc/nginx/certs/cert.pem"
  "postgres-server|/etc/postgresql/17/main/certs/cert.pem"
  "backend-device|/etc/mes/mqtt-client/cert.pem"
  "os-trusted-ca|/etc/ssl/mes-ca.crt"
)
if [[ -f "$EXTRA_FILE" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    CERTS+=("$line")
  done < "$EXTRA_FILE"
fi

now_epoch="${MES_CERT_CHECK_NOW:-$(date +%s)}"
problems=()
min_days=999999
soonest=""
n=0

printf '%-18s %-26s %6s\n' CERTIFICATE EXPIRES DAYS
for entry in "${CERTS[@]}"; do
  label="${entry%%|*}"
  path="${entry#*|}"
  if [[ ! "$label" =~ ^[A-Za-z0-9._-]+$ || "$entry" != *"|"* ]]; then
    problems+=("bad entry '$entry'"); continue
  fi
  n=$((n + 1))
  if ! end_line=$(openssl x509 -in "$path" -noout -enddate 2>/dev/null); then
    problems+=("$label: cannot read $path")
    printf '%-18s %-26s %6s\n' "$label" "unreadable" "-"
    continue
  fi
  end="${end_line#notAfter=}"
  end_epoch=$(date -d "$end" +%s)
  days=$(( (end_epoch - now_epoch) / 86400 ))
  printf '%-18s %-26s %6s\n' "$label" "$end" "$days"
  if (( end_epoch <= now_epoch )); then
    problems+=("$label: EXPIRED on $end")
  elif (( days <= WARN_DAYS )); then
    problems+=("$label: expires in $days day(s) ($end)")
  fi
  if (( days < min_days )); then min_days=$days; soonest="$label"; fi
done

status=success
msg=""
if (( ${#problems[@]} > 0 )); then
  status=failure
  msg=$(IFS=';'; echo "${problems[*]}")
  echo "PROBLEMS: $msg" >&2
fi
(( n > 0 )) || { status=failure; msg="no certificates configured"; min_days=0; }
detail=$(printf '{"checked":%d,"min_days":%d,"soonest":"%s"}' "$n" "$min_days" "$soonest")

if (( record == 1 )); then
  runuser -u postgres -- psql -X -q -d "$DB_NAME" -v ON_ERROR_STOP=1 \
    -v name="$JOB" -v status="$status" -v msg="${msg:0:500}" -v detail="$detail" <<'SQL' \
    || echo "warning: could not record the check result" >&2
INSERT INTO job_status (name, last_run_at, last_status, last_error, last_success_at, last_detail)
VALUES (:'name', now(), :'status', NULLIF(:'msg', ''),
        CASE WHEN :'status' = 'success' THEN now() END, :'detail'::jsonb)
ON CONFLICT (name) DO UPDATE SET
  last_run_at     = EXCLUDED.last_run_at,
  last_status     = EXCLUDED.last_status,
  last_error      = EXCLUDED.last_error,
  last_success_at = COALESCE(EXCLUDED.last_success_at, job_status.last_success_at),
  last_detail     = COALESCE(EXCLUDED.last_detail, job_status.last_detail);
SQL
fi

[[ "$status" == success ]] || exit 1
echo "OK: $n certificates, soonest expiry: $soonest in $min_days day(s)"

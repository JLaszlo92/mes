#!/usr/bin/env bash
#
# MES Postgres mentés: helyi másolat + S3. A mes-backup.timer futtatja naponta.
#
# - pg_dump custom formátumban (tömörített, pg_restore-ral visszaállítható),
#   postgres superuserként peer auth-tal: így nem kell jelszó, és a TimescaleDB
#   belső katalógusa is biztosan olvasható.
# - A dumpot feltöltés előtt pg_restore --list-tel ellenőrzi, hogy ép archívum.
# - S3 kulcsok: daily/ minden nap, weekly/ vasárnap, monthly/ minden hónap 1-jén.
#   A megőrzést (törlést) az S3 bucket lifecycle szabályai végzik, NEM ez a
#   szkript — a feltöltő IAM felhasználónak szándékosan nincs törlési joga.
# - Helyben az utolsó LOCAL_KEEP darab dump marad (gyors visszaállításhoz).
#
# - Minden futás végén (sikernél ÉS hibánál is) beírja az eredményt a
#   job_status táblába (név: db_backup). A backend backup-health-evaluator.ts
#   ebből riaszt a MES-ben, ha a futás sikertelen, vagy 26 órája nem volt
#   sikeres mentés.
#
# Konfiguráció: /etc/mes/backup.env (lásd backup.env.example).
# A pg_dump "circular foreign-key constraints" figyelmeztetései TimescaleDB-nél
# normálisak (hypertable/chunk katalógus), nem jelentenek hibát.

set -Eeuo pipefail
umask 077

CONFIG=/etc/mes/backup.env
DB_NAME=mes
last_error=""
step="starting"
tmp=""
detail=""

# Az eredmény beírása a job_status táblába. A hibaüzenet tetszőleges
# karaktereket tartalmazhat, ezért psql változóként (:'msg') megy át, nem
# stringbe fűzve. Ha maga a beírás nem sikerül (pl. az adatbázis áll), azt
# a backend "26 órája nincs sikeres mentés" ellenőrzése így is elkapja.
record_status() {
  local status="$1" msg="$2" det="$3"
  runuser -u postgres -- psql -X -q -d "$DB_NAME" -v ON_ERROR_STOP=1 \
    -v status="$status" -v msg="${msg:0:500}" -v detail="$det" <<'SQL'
INSERT INTO job_status (name, last_run_at, last_status, last_error, last_success_at, last_detail)
VALUES ('db_backup', now(), :'status', NULLIF(:'msg', ''),
        CASE WHEN :'status' = 'success' THEN now() END, NULLIF(:'detail', '')::jsonb)
ON CONFLICT (name) DO UPDATE SET
  last_run_at     = EXCLUDED.last_run_at,
  last_status     = EXCLUDED.last_status,
  last_error      = EXCLUDED.last_error,
  last_success_at = COALESCE(EXCLUDED.last_success_at, job_status.last_success_at),
  last_detail     = COALESCE(EXCLUDED.last_detail, job_status.last_detail);
SQL
}

on_exit() {
  local code=$?
  [[ -n "$tmp" ]] && rm -f "$tmp"
  if (( code == 0 )); then
    record_status success "" "$detail" || echo "warning: could not record backup status" >&2
  else
    record_status failure "${last_error:-exit code $code}" "" || echo "warning: could not record backup status" >&2
  fi
  exit "$code"
}
trap on_exit EXIT
# A riasztásba az éppen futó lépés neve és a hibázó parancs kerül.
trap 'last_error="$step failed (exit $?) — details: journalctl -u mes-backup"' ERR

die() {
  last_error="$1"
  echo "error: $1" >&2
  exit 1
}

[[ -r "$CONFIG" ]] || die "$CONFIG not found or not readable"
# shellcheck source=/dev/null
source "$CONFIG"

[[ -n "${S3_BUCKET:-}" ]] || die "S3_BUCKET is not set in $CONFIG"
[[ -n "${AWS_PROFILE:-}" ]] || die "AWS_PROFILE is not set in $CONFIG"
[[ -n "${AWS_REGION:-}" ]] || die "AWS_REGION is not set in $CONFIG"
DB_NAME="${DB_NAME:-mes}"
LOCAL_DIR="${LOCAL_DIR:-/var/backups/mes}"
LOCAL_KEEP="${LOCAL_KEEP:-3}"
S3_ENDPOINT_URL="${S3_ENDPOINT_URL:-}"
export AWS_PROFILE AWS_REGION

aws_s3() {
  if [[ -n "$S3_ENDPOINT_URL" ]]; then
    aws --endpoint-url "$S3_ENDPOINT_URL" s3 "$@"
  else
    aws s3 "$@"
  fi
}

stamp=$(date -u +%Y%m%dT%H%M%SZ)
host=$(hostname -s)
name="${DB_NAME}-${host}-${stamp}.dump"

mkdir -p "$LOCAL_DIR"
chmod 700 "$LOCAL_DIR"
tmp="$LOCAL_DIR/.${name}.partial"
out="$LOCAL_DIR/$name"

step="dumping database"
echo "dumping database '$DB_NAME'..."
runuser -u postgres -- pg_dump --format=custom --compress=6 "$DB_NAME" > "$tmp"

# Ép, olvasható archívum? (Egy félbeszakadt vagy sérült dump itt elbukik.)
step="verifying dump archive"
runuser -u postgres -- pg_restore --list < "$tmp" > /dev/null

mv "$tmp" "$out"
tmp=""
size=$(du -h "$out" | cut -f1)
sha=$(sha256sum "$out" | cut -d' ' -f1)
echo "dump ok: $name ($size, sha256 $sha)"

step="uploading to S3"
aws_s3 cp "$out" "s3://$S3_BUCKET/daily/$name" --only-show-errors
echo "uploaded: s3://$S3_BUCKET/daily/$name"

# Szerveroldali másolás, nem újrafeltöltés.
if [[ "$(date -u +%u)" == "7" ]]; then
  step="copying to weekly/"
  aws_s3 cp --copy-props none "s3://$S3_BUCKET/daily/$name" "s3://$S3_BUCKET/weekly/$name" --only-show-errors
  echo "copied to weekly/"
fi
if [[ "$(date -u +%d)" == "01" ]]; then
  step="copying to monthly/"
  aws_s3 cp --copy-props none "s3://$S3_BUCKET/daily/$name" "s3://$S3_BUCKET/monthly/$name" --only-show-errors
  echo "copied to monthly/"
fi

# Helyi megőrzés: a legfrissebb LOCAL_KEEP darab marad.
step="pruning local dumps"
# shellcheck disable=SC2012  # saját, ellenőrzött nevű fájlok
mapfile -t old < <(ls -1t "$LOCAL_DIR"/"${DB_NAME}"-*.dump 2>/dev/null | tail -n +"$((LOCAL_KEEP + 1))")
if (( ${#old[@]} > 0 )); then
  rm -f -- "${old[@]}"
  echo "removed ${#old[@]} old local dump(s)"
fi

detail=$(printf '{"file": "%s", "size_bytes": %s, "sha256": "%s"}' "$name" "$(stat -c %s "$out")" "$sha")
echo "backup complete"

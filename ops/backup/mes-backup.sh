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
# Konfiguráció: /etc/mes/backup.env (lásd backup.env.example).
# A pg_dump "circular foreign-key constraints" figyelmeztetései TimescaleDB-nél
# normálisak (hypertable/chunk katalógus), nem jelentenek hibát.

set -euo pipefail
umask 077

CONFIG=/etc/mes/backup.env
if [[ ! -r "$CONFIG" ]]; then
  echo "error: $CONFIG not found or not readable" >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$CONFIG"

: "${S3_BUCKET:?S3_BUCKET is not set in $CONFIG}"
: "${AWS_PROFILE:?AWS_PROFILE is not set in $CONFIG}"
: "${AWS_REGION:?AWS_REGION is not set in $CONFIG}"
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
trap 'rm -f "$tmp"' EXIT

echo "dumping database '$DB_NAME'..."
runuser -u postgres -- pg_dump --format=custom --compress=6 "$DB_NAME" > "$tmp"

# Ép, olvasható archívum? (Egy félbeszakadt vagy sérült dump itt elbukik.)
runuser -u postgres -- pg_restore --list < "$tmp" > /dev/null

mv "$tmp" "$out"
size=$(du -h "$out" | cut -f1)
sha=$(sha256sum "$out" | cut -d' ' -f1)
echo "dump ok: $name ($size, sha256 $sha)"

aws_s3 cp "$out" "s3://$S3_BUCKET/daily/$name" --only-show-errors
echo "uploaded: s3://$S3_BUCKET/daily/$name"

# Szerveroldali másolás, nem újrafeltöltés.
if [[ "$(date -u +%u)" == "7" ]]; then
  aws_s3 cp "s3://$S3_BUCKET/daily/$name" "s3://$S3_BUCKET/weekly/$name" --only-show-errors
  echo "copied to weekly/"
fi
if [[ "$(date -u +%d)" == "01" ]]; then
  aws_s3 cp "s3://$S3_BUCKET/daily/$name" "s3://$S3_BUCKET/monthly/$name" --only-show-errors
  echo "copied to monthly/"
fi

# Helyi megőrzés: a legfrissebb LOCAL_KEEP darab marad.
# shellcheck disable=SC2012  # saját, ellenőrzött nevű fájlok
mapfile -t old < <(ls -1t "$LOCAL_DIR"/"${DB_NAME}"-*.dump 2>/dev/null | tail -n +"$((LOCAL_KEEP + 1))")
if (( ${#old[@]} > 0 )); then
  rm -f -- "${old[@]}"
  echo "removed ${#old[@]} old local dump(s)"
fi

echo "backup complete"

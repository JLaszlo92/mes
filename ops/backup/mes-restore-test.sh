#!/usr/bin/env bash
#
# Visszaállítási próba — egy soha ki nem próbált mentés nem mentés.
#
# A legfrissebb daily mentést letölti S3-ból (így a letöltés is tesztelve van),
# vagy a megadott helyi dump fájlt használja, visszaállítja egy ideiglenes
# adatbázisba (<DB_NAME>_restore_test), összeveti a táblákat és sorszámokat
# az élő adatbázissal, majd törli az ideiglenes adatbázist. Az élő adatbázist
# csak olvassa.
#
#   mes-restore-test.sh                      # legfrissebb daily/ S3-ból
#   mes-restore-test.sh /var/backups/mes/X.dump
#
# TimescaleDB: a visszaállítás timescaledb_pre_restore() / post_restore()
# közé kerül, ahogy a TimescaleDB dokumentáció előírja; a célgépen ugyanannak
# a TimescaleDB verziónak kell lennie, mint a mentéskor.

set -euo pipefail
umask 077

CONFIG=/etc/mes/backup.env
# shellcheck source=/dev/null
source "$CONFIG"
: "${S3_BUCKET:?S3_BUCKET is not set in $CONFIG}"
: "${AWS_PROFILE:?}"
: "${AWS_REGION:?}"
DB_NAME="${DB_NAME:-mes}"
S3_ENDPOINT_URL="${S3_ENDPOINT_URL:-}"
TEST_DB="${DB_NAME}_restore_test"
export AWS_PROFILE AWS_REGION

aws_s3() {
  if [[ -n "$S3_ENDPOINT_URL" ]]; then
    aws --endpoint-url "$S3_ENDPOINT_URL" s3 "$@"
  else
    aws s3 "$@"
  fi
}

as_postgres() { runuser -u postgres -- "$@"; }
psql_db() { local db="$1"; shift; as_postgres psql -X -v ON_ERROR_STOP=1 -qAt -d "$db" "$@"; }

workdir=$(mktemp -d)
# shellcheck disable=SC2317  # trap-ből hívódik
cleanup() {
  rm -rf "$workdir"
  as_postgres dropdb --if-exists "$TEST_DB" 2>/dev/null || true
}
trap cleanup EXIT

src="${1:-}"
if [[ -z "$src" ]]; then
  latest=$(aws_s3 ls "s3://$S3_BUCKET/daily/" | awk '{print $4}' | grep '\.dump$' | sort | tail -n 1)
  if [[ -z "$latest" ]]; then
    echo "error: no backups found in s3://$S3_BUCKET/daily/" >&2
    exit 1
  fi
  echo "downloading s3://$S3_BUCKET/daily/$latest ..."
  aws_s3 cp "s3://$S3_BUCKET/daily/$latest" "$workdir/$latest" --only-show-errors
  src="$workdir/$latest"
fi
[[ -r "$src" ]] || { echo "error: cannot read $src" >&2; exit 1; }

echo "restoring $(basename "$src") into '$TEST_DB'..."
as_postgres dropdb --if-exists "$TEST_DB"
as_postgres createdb "$TEST_DB"
psql_db "$TEST_DB" -c "CREATE EXTENSION IF NOT EXISTS timescaledb;" -c "SELECT timescaledb_pre_restore();" > /dev/null
# A fájlt root nyitja meg és stdin-en kapja a pg_restore, így a postgres
# felhasználónak nem kell olvasási jog a (0700-as) mentési könyvtárra.
as_postgres pg_restore --dbname="$TEST_DB" < "$src"
psql_db "$TEST_DB" -c "SELECT timescaledb_post_restore();" -c "ANALYZE;" > /dev/null

tables_sql="SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;"
mapfile -t live_tables < <(psql_db "$DB_NAME" -c "$tables_sql")
mapfile -t restored_tables < <(psql_db "$TEST_DB" -c "$tables_sql")

status=0
if [[ "${live_tables[*]}" != "${restored_tables[*]}" ]]; then
  echo "MISMATCH: table list differs between live and restored database" >&2
  diff <(printf '%s\n' "${live_tables[@]}") <(printf '%s\n' "${restored_tables[@]}") >&2 || true
  status=1
fi

printf '\n%-40s %12s %12s\n' "table" "live" "restored"
for t in "${restored_tables[@]}"; do
  live=$(psql_db "$DB_NAME" -c "SELECT count(*) FROM public.\"$t\";" 2>/dev/null || echo "?")
  restored=$(psql_db "$TEST_DB" -c "SELECT count(*) FROM public.\"$t\";")
  printf '%-40s %12s %12s\n' "$t" "$live" "$restored"
done

# Az élő adatbázis a mentés óta tovább írt, így a sorszámok eltérése
# várható és nem hiba — a táblázat szemrevételezésre való. Kemény feltétel:
# ugyanazok a táblák, és az events tábla nem üres.
events_restored=$(psql_db "$TEST_DB" -c "SELECT count(*) FROM public.events;" 2>/dev/null || echo 0)
if (( events_restored == 0 )); then
  echo "FAIL: restored events table is empty" >&2
  status=1
fi

if (( status == 0 )); then
  echo -e "\nrestore test PASSED ($(basename "$src"))"
else
  echo -e "\nrestore test FAILED" >&2
fi
exit "$status"

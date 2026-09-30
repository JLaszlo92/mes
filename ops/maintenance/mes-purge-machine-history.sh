#!/usr/bin/env bash
#
# Megnevezett gépek ELŐZMÉNY adatainak törlése (pl. tesztadatok a pilot előtt).
#
#   mes-purge-machine-history.sh MACHINE_ID...            # csak kiírja, mit törölne
#   mes-purge-machine-history.sh --apply MACHINE_ID...    # töröl (megerősítést kér)
#
# Opciók:
#   --apply        ténylegesen töröl; enélkül csak összesít (dry run)
#   --yes          nem kér interaktív megerősítést (--apply mellett)
#   --allow-live   akkor is fut, ha egy gép az utolsó 5 percben adatot kapott
#
# Biztosítékok:
#  - Csak a HISTORY listán lévő táblákból töröl, csak a megnevezett gépekre.
#    A gép maga és a konfigurációja (CONFIG lista) megmarad. Az audit_log-hoz
#    soha nem nyúl — egy törölhető audit napló nem audit napló.
#  - Ha a sémában olyan machine_id-s tábla van, ami egyik listán sincs,
#    nem fut le: egy új táblát előbb be kell sorolni (egy új konfigurációs
#    tábla így nem törlődhet csendben).
#  - --apply csak akkor fut, ha van egy órán belüli sikeres mentés
#    (job_status 'db_backup'), és ha a gépek nem kapnak épp adatot (különben
#    a futó szimulátor / edge agent percek alatt újratöltené).
#  - Minden törlés egyetlen tranzakcióban: hiba esetén semmi nem törlődik.
#  - A végén egy 'machine_history_purged' audit bejegyzés készül a törölt
#    sorszámokkal, és a backend újraindul (memóriában tartott gépállapotok).

set -Eeuo pipefail

DB_NAME="${DB_NAME:-mes}"

# Géphez kötött ELŐZMÉNY — ezekből töröl. A sorrend a függőségeket követi.
HISTORY=(
  downtime_periods
  alerts
  fault_reports
  lots
  work_order_assignments
  maintenance_work_orders
  production_counts_hourly
  events
)
# Géphez kötött KONFIGURÁCIÓ — ezekhez nem nyúl.
CONFIG=(
  alert_rules
  edge_node_channels
  machine_fault_codes
  machine_status_definitions
  preventive_maintenance_schedules
  terminal_ui_machines
  user_machine_scope
)

apply=false; assume_yes=false; allow_live=false
machines=()
for arg in "$@"; do
  case "$arg" in
    --apply) apply=true ;;
    --yes) assume_yes=true ;;
    --allow-live) allow_live=true ;;
    -h|--help) sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "error: unknown option $arg" >&2; exit 2 ;;
    *) machines+=("$arg") ;;
  esac
done

(( ${#machines[@]} > 0 )) || { echo "error: no machine ids given (see --help)" >&2; exit 2; }
for m in "${machines[@]}"; do
  [[ "$m" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "error: invalid machine id '$m'" >&2; exit 2; }
done
ids_csv=$(IFS=,; echo "${machines[*]}")

psql_q() { runuser -u postgres -- psql -X -q -At -v ON_ERROR_STOP=1 -d "$DB_NAME" -v ids="$ids_csv" "$@"; }
in_list() { local x="$1"; shift; local e; for e in "$@"; do [[ "$e" == "$x" ]] && return 0; done; return 1; }

# 1) Ismeretlen gép?
mapfile -t unknown < <(psql_q <<'SQL'
SELECT i FROM unnest(string_to_array(:'ids', ',')) AS i
WHERE NOT EXISTS (SELECT 1 FROM machines WHERE id = i) ORDER BY 1;
SQL
)
if (( ${#unknown[@]} > 0 )); then
  echo "error: unknown machine id(s): ${unknown[*]}" >&2
  exit 1
fi

# 2) Minden machine_id-s tábla be van sorolva?
mapfile -t tables < <(psql_q <<'SQL'
SELECT c.table_name FROM information_schema.columns c
JOIN information_schema.tables t USING (table_schema, table_name)
WHERE c.table_schema = 'public' AND c.column_name = 'machine_id'
  AND t.table_type = 'BASE TABLE' AND c.table_name <> 'machines'
ORDER BY 1;
SQL
)
unclassified=()
for t in "${tables[@]}"; do
  in_list "$t" "${HISTORY[@]}" || in_list "$t" "${CONFIG[@]}" || unclassified+=("$t")
done
if (( ${#unclassified[@]} > 0 )); then
  echo "error: table(s) with a machine_id column that are neither HISTORY nor CONFIG: ${unclassified[*]}" >&2
  echo "       classify them in $0 before running it." >&2
  exit 1
fi
history_present=()
for t in "${HISTORY[@]}"; do in_list "$t" "${tables[@]}" && history_present+=("$t"); done

# 3) Összesítés
echo "Machines: ${machines[*]}"
echo
printf '%-34s %12s\n' "history table" "rows to delete"
total=0
for t in "${history_present[@]}"; do
  n=$(psql_q <<<"SELECT count(*) FROM public.\"$t\" WHERE machine_id = ANY(string_to_array(:'ids', ','));")
  printf '%-34s %12s\n' "$t" "$n"
  total=$(( total + n ))
done
printf '%-34s %12s\n' "TOTAL" "$total"
echo
echo "Kept: the machines themselves, ${CONFIG[*]}, and audit_log."

mapfile -t live < <(psql_q <<'SQL'
SELECT DISTINCT machine_id FROM events
WHERE machine_id = ANY(string_to_array(:'ids', ',')) AND "timestamp" > now() - interval '5 minutes'
ORDER BY 1;
SQL
)
if (( ${#live[@]} > 0 )); then
  echo
  echo "WARNING: still receiving data (last 5 min): ${live[*]}"
  echo "         Stop the simulator / edge agent for these first, or the data will come back."
fi

if ! $apply; then
  echo
  echo "Dry run — nothing deleted. Re-run with --apply to delete."
  exit 0
fi

# 4) --apply előfeltételek
if (( ${#live[@]} > 0 )) && ! $allow_live; then
  echo "error: refusing to purge machines that are still receiving data (use --allow-live to override)" >&2
  exit 1
fi
fresh=$(psql_q <<<"SELECT count(*) FROM job_status WHERE name = 'db_backup' AND last_status = 'success' AND last_success_at > now() - interval '1 hour';" 2>/dev/null || echo 0)
if [[ "$fresh" != "1" ]]; then
  echo "error: no successful backup in the last hour — run: systemctl start mes-backup.service" >&2
  exit 1
fi
if (( total == 0 )); then
  echo "Nothing to delete."
  exit 0
fi

if ! $assume_yes; then
  [[ -t 0 ]] || { echo "error: not a terminal — pass --yes to confirm non-interactively" >&2; exit 1; }
  read -r -p "Delete $total rows of history for ${machines[*]}? Type 'purge' to continue: " answer
  [[ "$answer" == "purge" ]] || { echo "Aborted — nothing deleted."; exit 1; }
fi

# 5) Törlés egy tranzakcióban + audit bejegyzés
sql="BEGIN;"
for t in "${history_present[@]}"; do
  sql+=$'\n'"DELETE FROM public.\"$t\" WHERE machine_id = ANY(string_to_array(:'ids', ','));"
done
sql+=$'\n'"INSERT INTO audit_log (id, actor_email, action, target, details)
VALUES (gen_random_uuid()::text, 'system:mes-purge-machine-history (' || :'who' || ')', 'machine_history_purged',
        :'ids', jsonb_build_object('machines', string_to_array(:'ids', ','), 'rows', :'total'::int));"
sql+=$'\n'"COMMIT;"
psql_q -v who="$(whoami)@$(hostname -s)" -v total="$total" <<<"$sql"
echo "Deleted $total rows."

if systemctl list-unit-files mes-backend.service >/dev/null 2>&1 && systemctl is-enabled mes-backend.service >/dev/null 2>&1; then
  systemctl restart mes-backend.service
  echo "mes-backend restarted (in-memory machine state reloaded)."
else
  echo "note: mes-backend.service not found — restart the backend yourself."
fi

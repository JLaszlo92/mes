#!/usr/bin/env bash
# Chaos slice 20: 403 for roles that are not allowed. Run as root on node-dc.
# Creates temporary users chaos-*@emlid.test with sessions directly in the database
# (no password, no login possible) and removes them on exit.
set -u
BASE=https://localhost

sql() { su - postgres -c "psql -d mes -qtAX -v ON_ERROR_STOP=1"; }
cleanup() { echo "delete from users where email like 'chaos-%@emlid.test';" | sql >/dev/null; echo "cleanup done"; rm -f "$BODY"; }
BODY=$(mktemp)
trap cleanup EXIT

declare -A TOKEN
mkuser() { # name role active expires_interval
  local name=$1 role=$2 active=$3 ttl=$4 tok hash
  tok=$(openssl rand -hex 32)
  hash=$(printf %s "$tok" | sha256sum | cut -d' ' -f1)
  sql <<SQL
insert into users (id, email, password_hash, role, is_active)
  values (gen_random_uuid()::text, 'chaos-$name@emlid.test', 'chaos-test-no-login', '$role', $active)
  on conflict (email) do update set role = excluded.role, is_active = excluded.is_active;
insert into sessions (token_hash, user_id, expires_at)
  select '$hash', id, now() + interval '$ttl' from users where email = 'chaos-$name@emlid.test';
SQL
  TOKEN[$name]=$tok
}

mkuser operator operator true '1 hour'
mkuser supervisor supervisor true '1 hour'
mkuser maintenance maintenance true '1 hour'
mkuser manager manager true '1 hour'
mkuser inactive manager false '1 hour'
mkuser expired manager true '-1 minute'

call() { # method path token ("" = none)
  local m=$1 p=$2 t=$3 args=(-sk -o "$BODY" -w '%{http_code}' -X "$m")
  [ "$m" != GET ] && args+=(-H 'content-type: application/json' -d '{}')
  if [ -n "$t" ]; then
    printf 'Authorization: Bearer %s\n' "$t" | curl "${args[@]}" -H @- "$BASE$p"
  else
    curl "${args[@]}" "$BASE$p"
  fi
}

ROUTES=(
  "GET /api/audit-log admin"
  "GET /api/audit-log/actions admin"
  "POST /api/license/reload admin"
  "GET /api/alert-rules admin,manager"
  "GET /api/edge-nodes admin,manager"
  "GET /api/shift-patterns admin,manager"
  "GET /api/calendars admin,manager"
  "GET /api/users/assignable maintenance,supervisor,manager,admin"
  "POST /api/machine-registry admin,manager"
  "POST /api/machine-registry/bulk admin,manager"
  "POST /api/work-orders admin,manager"
  "POST /api/work-orders/bulk admin,manager"
)

fail=0; shown=0
printf '%-12s %-5s %-34s %-9s %-5s %s\n' ROLE METHOD PATH EXPECT GOT RESULT
for role in operator supervisor maintenance manager; do
  for r in "${ROUTES[@]}"; do
    read -r m p allowed <<<"$r"
    got=$(call "$m" "$p" "${TOKEN[$role]}")
    if [[ ",$allowed," == *",$role,"* ]]; then
      if [ "$m" != GET ]; then continue; fi        # allowed + mutating: not exercised
      exp="not 403"; { [ "$got" != 403 ] && [ "$got" != 401 ]; } && res=OK || { res=FAIL; fail=$((fail+1)); }
    else
      exp=403; [ "$got" = 403 ] && res=OK || { res=FAIL; fail=$((fail+1)); }
      if [ "$got" = 403 ] && [ $shown = 0 ]; then echo "(example 403 body: $(head -c 200 "$BODY"))"; shown=1; fi
    fi
    printf '%-12s %-5s %-34s %-9s %-5s %s\n' "$role" "$m" "$p" "$exp" "$got" "$res"
  done
done

echo; echo "--- no / bad / inactive / expired token: 401 expected"
for who in none garbage inactive expired; do
  case $who in none) t="";; garbage) t="deadbeef";; *) t="${TOKEN[$who]}";; esac
  got=$(call GET /api/edge-nodes "$t")
  [ "$got" = 401 ] && res=OK || { res=FAIL; fail=$((fail+1)); }
  printf '%-12s %-5s %-34s %-9s %-5s %s\n' "$who" GET /api/edge-nodes 401 "$got" "$res"
done

echo; echo "failures: $fail"

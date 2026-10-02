#!/usr/bin/env bash
# Step 2 (and revocation). Run as root on node-dc.
#
#   mosquitto-device-acl.sh add <name>      # edge node: may publish events, receive acks
#   mosquitto-device-acl.sh remove <name>   # revoke: the certificate still exists but is useless
#   mosquitto-device-acl.sh list
#
# The user name is the CN of the device certificate. After every change the
# broker re-reads the file (systemctl reload mosquitto); connected clients
# keep working until they reconnect, so for an emergency revocation also
# restart the broker or disconnect the client.
set -euo pipefail

ACL_FILE="${ACL_FILE:-/etc/mosquitto/acl.conf}"
RELOAD_CMD="${RELOAD_CMD:-systemctl reload mosquitto}"
BACKUP_DIR="${BACKUP_DIR:-/root}"

die() { echo "ERROR: $*" >&2; exit 1; }
[[ -f "$ACL_FILE" ]] || die "$ACL_FILE not found"

cmd="${1:-}"; name="${2:-}"
valid_name() { [[ "$1" =~ ^[a-z][a-z0-9-]{1,30}$ ]]; }
reserved() { [[ "$1" == "backend" || "$1" == "admin-laptop" ]]; }
present() { grep -qx "user $1" "$ACL_FILE"; }
backup() { cp -p "$ACL_FILE" "$BACKUP_DIR/acl.conf.bak-$(date +%Y%m%d-%H%M%S)-$$"; }

case "$cmd" in
  list)
    grep '^user ' "$ACL_FILE" | sed 's/^user //'
    ;;
  add)
    valid_name "$name" || die "Usage: $0 add <name>  (lowercase letters, digits, '-')"
    reserved "$name" && die "'$name' is reserved"
    present "$name" && die "'$name' already has an ACL block"
    backup
    {
      printf '\n# added %s: edge node\n' "$(date +%F)"
      printf 'user %s\n' "$name"
      printf 'topic write mes/machines/+/events\n'
      printf 'topic read mes/machines/+/acks\n'
    } >> "$ACL_FILE"
    $RELOAD_CMD
    echo "Added '$name'. Users now:"; grep '^user ' "$ACL_FILE" | sed 's/^user /  /'
    ;;
  remove)
    valid_name "$name" || die "Usage: $0 remove <name>"
    reserved "$name" && die "'$name' is reserved (backend/admin-laptop are removed by hand, deliberately)"
    present "$name" || die "'$name' has no ACL block"
    backup
    tmp="$(mktemp)"
    # Drop the "user <name>" line and its rules up to the next blank line,
    # plus the "# added ..." comment line directly above it.
    awk -v n="$name" '
      { lines[NR] = $0 }
      END {
        skip = 0
        for (i = 1; i <= NR; i++) {
          if (lines[i] == "user " n) { skip = 1; if (i > 1 && lines[i-1] ~ /^# added /) out_n--; }
          if (skip) { if (lines[i] == "") { skip = 0 } ; continue }
          out[++out_n] = lines[i]
        }
        for (i = 1; i <= out_n; i++) print out[i]
      }' "$ACL_FILE" > "$tmp"
    present_after() { grep -qx "user $name" "$tmp"; }
    present_after && { rm -f "$tmp"; die "Removal failed, file unchanged"; }
    cat "$tmp" > "$ACL_FILE"; rm -f "$tmp"     # keeps owner and mode
    $RELOAD_CMD
    echo "Removed '$name'. Users now:"; grep '^user ' "$ACL_FILE" | sed 's/^user /  /'
    ;;
  *) die "Usage: $0 add|remove <name> | list" ;;
esac

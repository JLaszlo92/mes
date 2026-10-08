#!/usr/bin/env bash
# Chaos slice 23: disk of node-dc fills up. Run on node-dc as root.
#   status          free space as df sees it (percent used by the df rule: used / (used + avail)), the filler, the safety timer
#   fill-to <pct>   grow OR shrink the filler file until df shows about <pct>% used (non-root view); the root reserve stays untouched
#   fill-full       grow the filler until NOTHING is left for non-root users (postgres, mosquitto, www-data get ENOSPC);
#                   root keeps the ext4 reserved blocks (about 1.6 GiB), so ssh, rm and journald keep working
#   free            delete the filler (always works for root)
# Every fill (re)arms a safety timer: the filler is deleted by systemd SAFETY_MIN (default 15) minutes later, whatever happens.
# Longer test:  SAFETY_MIN=40 bash chaos-disk.sh fill-to 87
set -eu
DIR=/var/lib/mes-chaos
FILL=$DIR/filler
SAFETY=chaos-disk-safety
SAFETY_MIN=${SAFETY_MIN:-15}

read_fs() { # sets BS BLOCKS FREE AVAIL
  read -r BS BLOCKS FREE AVAIL < <(stat -f -c "%S %b %f %a" /)
}
used_pct() { # df rule
  read_fs
  local used=$((BLOCKS - FREE))
  echo $(( (used * 100 + used + AVAIL - 1) / (used + AVAIL) ))
}
filler_bytes() { [ -f "$FILL" ] && stat -c %s "$FILL" || echo 0; }
arm_safety() {
  systemctl stop "$SAFETY.timer" "$SAFETY.service" 2>/dev/null || true
  systemd-run --quiet --on-active=${SAFETY_MIN}m --unit=$SAFETY /bin/rm -f "$FILL"
  echo "safety timer: the filler is deleted automatically in $SAFETY_MIN minutes"
}
status() {
  read_fs
  echo "df rule: $(used_pct)% used | avail (non-root) $((AVAIL * BS / 1048576)) MiB | reserved for root $(((FREE - AVAIL) * BS / 1048576)) MiB | filler $(( $(filler_bytes) / 1048576 )) MiB"
  systemctl list-timers "$SAFETY.timer" --no-legend 2>/dev/null | cut -c1-90 || true
}

case "${1:-}" in
  status) status ;;
  fill-to)
    pct=${2:?usage: fill-to <percent 50-99>}
    [ "$pct" -ge 50 ] && [ "$pct" -le 99 ] || { echo "percent must be 50..99"; exit 2; }
    mkdir -p "$DIR"
    read_fs
    used=$((BLOCKS - FREE)); total=$((used + AVAIL))
    want_avail=$(( total * (100 - pct) / 100 ))
    cur=$(filler_bytes)
    new=$(( cur + (AVAIL - want_avail) * BS ))
    if [ "$new" -le 0 ]; then rm -f "$FILL"
    elif [ "$new" -gt "$cur" ]; then fallocate -l "$new" "$FILL"
    else truncate -s "$new" "$FILL"; fi
    arm_safety; status ;;
  fill-full)
    mkdir -p "$DIR"
    arm_safety   # first: even if the fill below ends with an error, the filler is removed automatically
    read_fs
    # leave nothing for non-root, but do not touch the root reserve (AVAIL is what non-root may still use).
    # ENOSPC at the very end is expected: other writers (postgres) use blocks while we allocate.
    fallocate -l $(( $(filler_bytes) + AVAIL * BS )) "$FILL" || echo "(fallocate ended with ENOSPC: the disk is full for non-root users, as intended)"
    status ;;
  free)
    rm -f "$FILL"
    systemctl stop "$SAFETY.timer" "$SAFETY.service" 2>/dev/null || true
    status ;;
  *) echo "usage: $0 status|fill-to <pct>|fill-full|free"; exit 2 ;;
esac

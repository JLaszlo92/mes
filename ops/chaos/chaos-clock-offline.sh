#!/usr/bin/env bash
# Chaos slice 22: the clock of the edge node is wrong AND the backend is unreachable at the start. Run on node-gate as root.
#   down     stop the agent (graceful, with the network), cut the network to node-dc (443, 8884), set the clock of the agent
#            process 5 minutes BEHIND (libfaketime), start the agent -> offline start from the cached configuration
#   net-up   bring the network back (the clock stays wrong): the background claim measures the offset
#   restore  stop the agent, remove the faketime drop-in, start the agent (the order of finding 31)
#   status   what is set right now
# Safety net: 20 minutes after "down" the network rules are removed by a systemd timer, whatever happens.
set -eu
DC=192.168.60.141
UNIT=mes-edge-node
DROPIN=/etc/systemd/system/$UNIT.service.d/faketime.conf
OFFSET=${OFFSET:--5m}
TIMES=/root/chaos-clock-offline.times
stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
mark() { echo "$1 $(stamp)" | tee -a "$TIMES"; }

net_down() {
  nft add table inet chaos
  nft add chain inet chaos out '{ type filter hook output priority 0 ; }'
  nft add chain inet chaos inp '{ type filter hook input priority 0 ; }'
  nft add rule inet chaos out ip daddr $DC tcp dport '{ 443, 8884 }' drop
  nft add rule inet chaos inp ip saddr $DC tcp sport '{ 443, 8884 }' drop
}
net_up() { nft delete table inet chaos 2>/dev/null || true; }

case "${1:-}" in
  down)
    LIB=$(find /usr -name 'libfaketime.so.1' 2>/dev/null | head -1)
    [ -n "$LIB" ] || { echo "libfaketime.so.1 not found (apt install libfaketime)"; exit 1; }
    systemctl stop $UNIT
    net_down
    systemd-run --quiet --on-active=20m --unit=chaos-clock-safety /usr/sbin/nft delete table inet chaos || true
    mkdir -p "$(dirname $DROPIN)"
    printf '[Service]\nEnvironment=LD_PRELOAD=%s\nEnvironment=FAKETIME=%s\nEnvironment=DONT_FAKE_MONOTONIC=1\n' "$LIB" "$OFFSET" > $DROPIN
    systemctl daemon-reload
    mark "down(network cut, clock $OFFSET, agent start)"
    systemctl start $UNIT
    echo "Wait about 4 minutes, then:  bash $0 net-up"
    ;;
  net-up)
    net_up
    mark "net-up(network back, clock still wrong)"
    echo "Watch 2 minutes, then:  bash $0 restore"
    ;;
  restore)
    systemctl stop $UNIT
    rm -f $DROPIN
    net_up
    systemctl stop chaos-clock-safety.timer 2>/dev/null || true
    systemctl daemon-reload
    systemctl start $UNIT
    mark "restore(clock and network back to normal)"
    ;;
  status)
    nft list table inet chaos 2>/dev/null || echo "network: not cut"
    [ -f $DROPIN ] && cat $DROPIN || echo "clock: normal (no drop-in)"
    systemctl show $UNIT -p ActiveState -p NRestarts
    cat "$TIMES" 2>/dev/null || true
    ;;
  *) echo "usage: $0 down|net-up|restore|status"; exit 2 ;;
esac

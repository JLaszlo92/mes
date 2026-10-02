#!/usr/bin/env bash
# Step 1 of adding an edge node. Run on the ADMIN machine (laptop), never on a
# node: it uses the device CA key (asks for its passphrase).
#
#   new-edge-node.sh <node-name> [broker-host]     e.g. new-edge-node.sh node-hall2 192.168.60.141
#
# Issues the node's client certificate and packs everything the node needs
# into ./bundle-<node-name>.tar.gz (contains the node's PRIVATE KEY: copy it
# to the node over scp, then delete it from everywhere else).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CA_SCRIPT="${MES_CA_SCRIPT:-$HERE/../ca/mes-ca.sh}"
DEVICE_CA_DIR="${MES_DEVICE_CA_DIR:-$HOME/mes-device-ca}"
SERVER_CA_DIR="${MES_CA_DIR:-$HOME/mes-ca}"

die() { echo "ERROR: $*" >&2; exit 1; }

name="${1:-}"
host="${2:-192.168.60.141}"
[[ -n "$name" ]] || die "Usage: $0 <node-name> [broker-host]"
[[ "$name" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || die "Node name: lowercase letters, digits, '-', 2-31 chars, starting with a letter"
case "$name" in backend|admin-laptop) die "'$name' is a reserved device name" ;; esac
[[ "$host" =~ ^[A-Za-z0-9.-]+$ ]] || die "Bad broker host '$host'"
[[ -f "$DEVICE_CA_DIR/root.crt" ]] || die "No device CA in $DEVICE_CA_DIR (run mes-ca.sh init-device)"
[[ -f "$SERVER_CA_DIR/root.crt" ]] || die "No server CA in $SERVER_CA_DIR"
[[ -f "$HERE/install-on-node.sh" ]] || die "install-on-node.sh not found next to this script"

out="$PWD/bundle-$name"
[[ ! -e "$out" && ! -e "$out.tar.gz" ]] || die "$out(.tar.gz) already exists; move it away first"

bash "$CA_SCRIPT" issue-device "$name" edge-node
issued="$DEVICE_CA_DIR/issued/$name"
[[ -f "$issued/cert.pem" && -f "$issued/key.pem" ]] || die "Certificate was not issued"

umask 077
mkdir -p "$out"
cp "$issued/cert.pem" "$out/cert.pem"
cp "$issued/key.pem" "$out/key.pem"
cp "$SERVER_CA_DIR/root.crt" "$out/mes-ca.crt"
cp "$HERE/install-on-node.sh" "$out/install-on-node.sh"
chmod 700 "$out/install-on-node.sh"
printf 'NODE_NAME=%s\nMES_HOST=%s\n' "$name" "$host" > "$out/settings.env"

tar czf "$out.tar.gz" -C "$PWD" "bundle-$name"
rm -rf "$out"
chmod 600 "$out.tar.gz"

cat <<MSG

Bundle: $out.tar.gz  (contains the private key)

Next:
  2. On node-dc:   ops/onboarding/mosquitto-device-acl.sh add $name
  3. In the MES UI: create the edge node "$name"; copy the token (shown once)
  4. On the node:  scp the bundle over, then
        tar xzf bundle-$name.tar.gz && cd bundle-$name && ./install-on-node.sh
     (it asks for the token; the edge agent must already be built there)
  5. Delete the bundle from the laptop and the node when done.
See ops/onboarding/README.md.
MSG

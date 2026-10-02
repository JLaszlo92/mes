#!/usr/bin/env bash
# Step 4 of adding an edge node. Run as root ON THE NEW NODE, from the
# unpacked bundle directory. Installs the certificate, the CA, the token and
# the systemd unit, checks the TLS connection to the broker and starts the
# service.
#
#   ./install-on-node.sh [--force] [--no-start]
#
# Needs: Node.js, and the edge agent already built (see README). The token
# comes from the MES UI and is typed in (not echoed, not kept in the bundle).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/settings.env"          # NODE_NAME, MES_HOST

AGENT_DIR="${MES_AGENT_DIR:-/root/mes/packages/edge-agent}"
DEST="${MES_DESTDIR:-}"              # test hook: install under a prefix, skip systemd
force=0; start=1
for a in "$@"; do
  case "$a" in
    --force) force=1 ;;
    --no-start) start=0 ;;
    *) echo "Unknown option $a" >&2; exit 1 ;;
  esac
done

die() { echo "ERROR: $*" >&2; exit 1; }
[[ -n "$DEST" || $EUID -eq 0 ]] || die "Run as root"
[[ "$NODE_NAME" =~ ^[a-z][a-z0-9-]{1,30}$ && "$MES_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || die "settings.env is malformed"
[[ -f "$AGENT_DIR/dist/index.js" ]] || die "Edge agent not built at $AGENT_DIR (expected dist/index.js) - see ops/onboarding/README.md step 4"
NODE_BIN="$(command -v node)" || die "Node.js not found"

CERT_DIR="$DEST/etc/mes/mqtt-client"
ENV_FILE="$DEST/etc/mes/edge-node.env"
CA_FILE="$DEST/etc/ssl/mes-ca.crt"
UNIT="$DEST/etc/systemd/system/mes-edge-node.service"

if [[ $force -eq 0 ]]; then
  for f in "$CERT_DIR/cert.pem" "$ENV_FILE" "$UNIT"; do
    [[ ! -e "$f" ]] || die "$f already exists - this node looks installed. Use --force to replace (it overwrites the certificate, token and unit)."
  done
fi

# --- check the bundle before touching anything --------------------------------
openssl x509 -in "$HERE/cert.pem" -noout >/dev/null 2>&1 || die "cert.pem is not a certificate"
subject="$(openssl x509 -in "$HERE/cert.pem" -noout -subject)"
[[ "$subject" == *"CN=$NODE_NAME"* || "$subject" == *"CN = $NODE_NAME"* ]] || die "Certificate subject ($subject) does not match node name $NODE_NAME"
openssl x509 -in "$HERE/cert.pem" -noout -checkend $((30 * 86400)) >/dev/null || die "Certificate expires within 30 days"
[[ "$(openssl x509 -in "$HERE/cert.pem" -noout -pubkey)" == "$(openssl pkey -in "$HERE/key.pem" -pubout)" ]] || die "key.pem does not belong to cert.pem"

# --- token --------------------------------------------------------------------
read -rsp "Edge node token for $NODE_NAME (from the MES UI, not shown): " token || true
echo
[[ -n "$token" && "$token" =~ ^[A-Za-z0-9._~+/=-]+$ ]] || die "Empty token, or it contains characters other than letters, digits and . _ ~ + / = - (paste only the token)"

# --- files --------------------------------------------------------------------
install -d -m 0700 "$DEST/etc/mes" "$CERT_DIR"
install -d -m 0755 "$DEST/etc/ssl" "$DEST/etc/systemd/system"
install -m 0644 "$HERE/cert.pem" "$CERT_DIR/cert.pem"
install -m 0600 "$HERE/key.pem"  "$CERT_DIR/key.pem"
if [[ -f "$CA_FILE" ]] && ! cmp -s "$HERE/mes-ca.crt" "$CA_FILE" && [[ $force -eq 0 ]]; then
  die "$CA_FILE exists and differs from the bundle's CA. Check it, or use --force."
fi
install -m 0644 "$HERE/mes-ca.crt" "$CA_FILE"
( umask 077; printf 'EDGE_NODE_TOKEN=%s\n' "$token" > "$ENV_FILE" )
chmod 600 "$ENV_FILE"

cat > "$UNIT" <<UNIT_EOF
[Unit]
Description=MES edge node ($NODE_NAME)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$AGENT_DIR
ExecStart=$NODE_BIN dist/index.js
EnvironmentFile=/etc/mes/edge-node.env
Environment=MQTT_URL=mqtts://$MES_HOST:8884
Environment=MQTT_CA_FILE=/etc/ssl/mes-ca.crt
Environment=MQTT_CLIENT_CERT=/etc/mes/mqtt-client/cert.pem
Environment=MQTT_CLIENT_KEY=/etc/mes/mqtt-client/key.pem
Environment=BACKEND_HTTP_URL=https://$MES_HOST
Environment=NODE_EXTRA_CA_CERTS=/etc/ssl/mes-ca.crt
Restart=on-failure
RestartSec=2
User=root

[Install]
WantedBy=multi-user.target
UNIT_EOF
echo "Installed certificate, CA, token file and unit."

# --- TLS preflight: the broker must accept this certificate (TLS 1.2 so a
#     rejected client certificate fails the handshake visibly) ---------------
# NB: OpenSSL 3 prints "Verify return code: 0 (ok)" even after an aborted
# handshake, so success needs a real cipher and no error/alert line as well.
tls_ok() {  # $1 = s_client output
  grep -q "Verify return code: 0" <<<"$1" || return 1
  grep -qiE "verify error|verification error|alert|handshake failure|error:|Cipher is \(NONE\)" <<<"$1" && return 1
  grep -qE "Cipher is [A-Za-z0-9_-]+" <<<"$1"
}
if [[ -z "$DEST" ]] && command -v openssl >/dev/null; then
  res="$(echo | timeout 10 openssl s_client -connect "$MES_HOST:8884" -tls1_2 -CAfile "$CA_FILE" \
        -cert "$CERT_DIR/cert.pem" -key "$CERT_DIR/key.pem" -verify_return_error 2>&1 || true)"
  if tls_ok "$res"; then
    echo "TLS check OK: the broker accepted the certificate."
  else
    echo "WARNING: TLS check to $MES_HOST:8884 did not succeed:" >&2
    grep -iE "verif|alert|error|refused|timed out|connect" <<<"$res" | head -n 5 >&2
    echo "The unit is installed but NOT started. Fix the cause (network, CA, or the device CA on the broker), then: systemctl start mes-edge-node" >&2
    start=0
  fi
fi

if [[ -n "$DEST" ]]; then echo "(test mode: systemd skipped)"; exit 0; fi
systemctl daemon-reload
systemctl enable mes-edge-node >/dev/null 2>&1
if [[ $start -eq 1 ]]; then
  systemctl restart mes-edge-node
  sleep 6
  echo "--- last log lines (a '409 another instance' for 1-2 minutes after a restart is normal) ---"
  journalctl -u mes-edge-node --no-pager -n 8 | cut -c1-200
fi
echo "Done. The node should show as online in the MES UI within a minute."

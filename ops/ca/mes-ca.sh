#!/usr/bin/env bash
# Minimal internal CA for the MES pilot (TLS server certificates).
#
# Run this on an ADMIN machine, NOT on node-dc: the root key must never sit
# on a node an attacker could compromise. Only the issued cert.pem/key.pem
# and the public ca.crt go to the nodes.
#
# The root key is encrypted; openssl asks for the passphrase. For automated
# tests only, MES_CA_PASSPHRASE can supply it (do not use it for real keys).
set -euo pipefail

CA_DIR="${MES_CA_DIR:-$HOME/mes-ca}"
ROOT_DAYS=3650
CERT_DAYS=365

usage() {
  cat >&2 <<EOF
Usage:
  $0 init
  $0 issue <name> <san>[,<san>...]
      e.g. $0 issue mosquitto DNS:mes.pilot.internal,IP:192.168.60.141
  $0 check <cert.pem>
Env: MES_CA_DIR (default ~/mes-ca)
EOF
  exit 1
}

# macOS ships bash 3.2, where an empty array under `set -u` is an error;
# hence the ${ARR[@]+"${ARR[@]}"} form below.
openssl version | grep -q '^OpenSSL' || {
  echo "OpenSSL (not LibreSSL) is required; on macOS: brew install openssl" >&2; exit 1; }

PASSIN=(); PASSOUT=()
if [[ -n "${MES_CA_PASSPHRASE:-}" ]]; then
  PASSIN=(-passin env:MES_CA_PASSPHRASE)
  PASSOUT=(-passout env:MES_CA_PASSPHRASE)
fi

cmd_init() {
  if [[ -e "$CA_DIR/root.key" ]]; then
    echo "A CA already exists in $CA_DIR" >&2; exit 1
  fi
  umask 077
  mkdir -p "$CA_DIR/issued"
  openssl ecparam -name prime256v1 -genkey -noout \
    | openssl pkcs8 -topk8 -v2 aes-256-cbc ${PASSOUT[@]+"${PASSOUT[@]}"} -out "$CA_DIR/root.key"
  openssl req -x509 -new -key "$CA_DIR/root.key" ${PASSIN[@]+"${PASSIN[@]}"} -sha256 \
    -days "$ROOT_DAYS" -subj "/O=MES Pilot/CN=MES Pilot Root CA" \
    -set_serial "0x$(openssl rand -hex 16)" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -addext "subjectKeyIdentifier=hash" \
    -out "$CA_DIR/root.crt"
  chmod 644 "$CA_DIR/root.crt"
  echo "Root CA created in $CA_DIR"
  echo "Back up root.key offline (encrypted USB / password manager). Distribute only root.crt."
}

cmd_issue() {
  local name="${1:-}" sans="${2:-}"
  [[ -n "$name" && -n "$sans" ]] || usage
  [[ "$name" =~ ^[a-z0-9._-]+$ ]] || { echo "Bad name (a-z 0-9 . _ -)" >&2; exit 1; }
  [[ -f "$CA_DIR/root.key" ]] || { echo "Run '$0 init' first" >&2; exit 1; }
  local dir="$CA_DIR/issued/$name"
  [[ ! -e "$dir" ]] || { echo "$dir exists; move it away to re-issue" >&2; exit 1; }
  umask 077
  mkdir -p "$dir"
  openssl ecparam -name prime256v1 -genkey -noout -out "$dir/key.pem"
  openssl req -new -key "$dir/key.pem" -subj "/O=MES Pilot/CN=$name" -out "$dir/req.csr"
  openssl x509 -req -in "$dir/req.csr" -CA "$CA_DIR/root.crt" -CAkey "$CA_DIR/root.key" ${PASSIN[@]+"${PASSIN[@]}"} \
    -set_serial "0x$(openssl rand -hex 16)" -days "$CERT_DAYS" -sha256 \
    -extfile <(printf '%s\n' \
      "basicConstraints=critical,CA:FALSE" \
      "keyUsage=critical,digitalSignature" \
      "extendedKeyUsage=serverAuth" \
      "subjectAltName=$sans" \
      "subjectKeyIdentifier=hash" \
      "authorityKeyIdentifier=keyid") \
    -out "$dir/cert.pem"
  rm -f "$dir/req.csr"
  cp "$CA_DIR/root.crt" "$dir/ca.crt"
  chmod 644 "$dir/cert.pem" "$dir/ca.crt"   # public; services run as their own user
  openssl verify -CAfile "$dir/ca.crt" "$dir/cert.pem"
  echo "Issued: $dir/{cert.pem,key.pem,ca.crt} (valid $CERT_DAYS days)"
}

cmd_check() {
  local cert="${1:-}"
  [[ -f "$cert" ]] || usage
  openssl x509 -in "$cert" -noout -subject -issuer -enddate -ext subjectAltName
  if openssl x509 -in "$cert" -noout -checkend $((30 * 86400)) >/dev/null; then
    echo "OK: valid for more than 30 days"
  else
    echo "WARNING: expires within 30 days (or already expired)" >&2
    exit 2
  fi
}

case "${1:-}" in
  init)  shift; cmd_init "$@" ;;
  issue) shift; cmd_issue "$@" ;;
  check) shift; cmd_check "$@" ;;
  *)     usage ;;
esac

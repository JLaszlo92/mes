#!/usr/bin/env bash
# Minimal internal CAs for the MES pilot.
#
#   server CA  (default dir ~/mes-ca)         -> TLS SERVER certificates
#                                                (Mosquitto, nginx, Postgres)
#   device CA  (default dir ~/mes-device-ca)  -> TLS CLIENT certificates, one
#                                                per device (backend, edge
#                                                nodes, simulators, ...)
#
# The two CAs are separate on purpose: whoever holds the device CA key decides
# which devices may exist at all (this is what licensing builds on), and a
# leaked server key or server CA never lets anyone mint a device identity.
#
# Run this on an ADMIN machine, NOT on node-dc: the root keys must never sit
# on a node an attacker could compromise. Only the issued cert.pem/key.pem
# and the public ca.crt go to the nodes.
#
# The root keys are encrypted; openssl asks for the passphrase. For automated
# tests only, MES_CA_PASSPHRASE can supply it (do not use it for real keys).
set -euo pipefail

CA_DIR="${MES_CA_DIR:-$HOME/mes-ca}"
DEVICE_CA_DIR="${MES_DEVICE_CA_DIR:-$HOME/mes-device-ca}"
ROOT_DAYS=3650
CERT_DAYS="${MES_CERT_DAYS:-365}"   # MES_CERT_DAYS: for tests only

usage() {
  cat >&2 <<EOF
Usage:
  $0 init                                  # server CA
  $0 issue <name> <san>[,<san>...]         # server certificate
      e.g. $0 issue mosquitto DNS:mes.pilot.internal,IP:192.168.60.141
  $0 init-device                           # device CA (separate key!)
  $0 issue-device <name> <role>            # client certificate for one device
      e.g. $0 issue-device node-gate edge-node
  $0 check <cert.pem>
  $0 status [--warn <days>]                # every issued certificate and its expiry
  $0 ics [file]                            # calendar reminders (.ics), 30 days before each expiry
Env: MES_CA_DIR (default ~/mes-ca), MES_DEVICE_CA_DIR (default ~/mes-device-ca)
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

# ca_init <dir> <common name>
ca_init() {
  local dir="$1" cn="$2"
  if [[ -e "$dir/root.key" ]]; then
    echo "A CA already exists in $dir" >&2; exit 1
  fi
  umask 077
  mkdir -p "$dir/issued"
  openssl ecparam -name prime256v1 -genkey -noout \
    | openssl pkcs8 -topk8 -v2 aes-256-cbc ${PASSOUT[@]+"${PASSOUT[@]}"} -out "$dir/root.key"
  openssl req -x509 -new -key "$dir/root.key" ${PASSIN[@]+"${PASSIN[@]}"} -sha256 \
    -days "$ROOT_DAYS" -subj "/O=MES Pilot/CN=$cn" \
    -set_serial "0x$(openssl rand -hex 16)" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -addext "subjectKeyIdentifier=hash" \
    -out "$dir/root.crt"
  chmod 644 "$dir/root.crt"
  echo "Root CA created in $dir"
  echo "Back up root.key offline (encrypted USB / password manager). Distribute only root.crt."
}

# ca_issue <dir> <name> <subject> <eku> <san or empty>
ca_issue() {
  local dir="$1" name="$2" subject="$3" eku="$4" sans="$5"
  [[ "$name" =~ ^[a-z0-9._-]+$ ]] || { echo "Bad name (a-z 0-9 . _ -)" >&2; exit 1; }
  [[ -f "$dir/root.key" ]] || { echo "No CA in $dir - run init first" >&2; exit 1; }
  local out="$dir/issued/$name"
  [[ ! -e "$out" ]] || { echo "$out exists; move it away to re-issue" >&2; exit 1; }
  local ext=("basicConstraints=critical,CA:FALSE"
             "keyUsage=critical,digitalSignature"
             "extendedKeyUsage=$eku"
             "subjectKeyIdentifier=hash"
             "authorityKeyIdentifier=keyid")
  if [[ -n "$sans" ]]; then ext+=("subjectAltName=$sans"); fi
  umask 077
  mkdir -p "$out"
  openssl ecparam -name prime256v1 -genkey -noout -out "$out/key.pem"
  openssl req -new -key "$out/key.pem" -subj "$subject" -out "$out/req.csr"
  openssl x509 -req -in "$out/req.csr" -CA "$dir/root.crt" -CAkey "$dir/root.key" ${PASSIN[@]+"${PASSIN[@]}"} \
    -set_serial "0x$(openssl rand -hex 16)" -days "$CERT_DAYS" -sha256 \
    -extfile <(printf '%s\n' "${ext[@]}") \
    -out "$out/cert.pem"
  rm -f "$out/req.csr"
  cp "$dir/root.crt" "$out/ca.crt"
  chmod 644 "$out/cert.pem" "$out/ca.crt"   # public; services run as their own user
  if [[ "$eku" == "clientAuth" ]]; then
    openssl verify -purpose sslclient -CAfile "$out/ca.crt" "$out/cert.pem"
  else
    openssl verify -CAfile "$out/ca.crt" "$out/cert.pem"
  fi
  echo "Issued: $out/{cert.pem,key.pem,ca.crt} (valid $CERT_DAYS days)"
}

cmd_init() { ca_init "$CA_DIR" "MES Pilot Root CA"; }

cmd_issue() {
  local name="${1:-}" sans="${2:-}"
  [[ -n "$name" && -n "$sans" ]] || usage
  ca_issue "$CA_DIR" "$name" "/O=MES Pilot/CN=$name" serverAuth "$sans"
}

cmd_init_device() { ca_init "$DEVICE_CA_DIR" "MES Pilot Device CA"; }

# The device name becomes the certificate CN, which Mosquitto uses as the MQTT
# user name (use_identity_as_username) - ACLs and revocation key on it.
cmd_issue_device() {
  local name="${1:-}" role="${2:-}"
  [[ -n "$name" && -n "$role" ]] || usage
  [[ "$role" =~ ^[a-z0-9._-]+$ ]] || { echo "Bad role (a-z 0-9 . _ -)" >&2; exit 1; }
  ca_issue "$DEVICE_CA_DIR" "$name" "/O=MES Pilot/OU=$role/CN=$name" clientAuth ""
}

cmd_check() {
  local cert="${1:-}"
  [[ -f "$cert" ]] || usage
  openssl x509 -in "$cert" -noout -subject -issuer -enddate -ext subjectAltName,extendedKeyUsage
  if openssl x509 -in "$cert" -noout -checkend $((30 * 86400)) >/dev/null; then
    echo "OK: valid for more than 30 days"
  else
    echo "WARNING: expires within 30 days (or already expired)" >&2
    exit 2
  fi
}

# ---- expiry overview ---------------------------------------------------------

# All certificates of both CAs as "label|path" lines.
all_certs() {
  local d c
  for d in "$CA_DIR" "$DEVICE_CA_DIR"; do
    [[ -f "$d/root.crt" ]] || continue
    echo "$(basename "$d") root|$d/root.crt"
    for c in "$d"/issued/*/cert.pem; do
      [[ -f "$c" ]] && echo "$(basename "$d")/$(basename "$(dirname "$c")")|$c"
    done
  done
  return 0
}

# Whole days until expiry (-1 = already expired). A binary search on
# `openssl -checkend` keeps this portable: no GNU/BSD date parsing.
days_left() {
  local cert="$1" lo=0 hi=4000 mid
  openssl x509 -in "$cert" -noout -checkend 0 >/dev/null 2>&1 || { echo -1; return; }
  while (( lo < hi )); do
    mid=$(( (lo + hi + 1) / 2 ))
    if openssl x509 -in "$cert" -noout -checkend $(( mid * 86400 )) >/dev/null 2>&1; then lo=$mid; else hi=$(( mid - 1 )); fi
  done
  echo "$lo"
}

cmd_status() {
  local warn=60
  if [[ "${1:-}" == "--warn" ]]; then
    warn="${2:-}"; [[ "$warn" =~ ^[0-9]+$ ]] || usage
  elif [[ -n "${1:-}" ]]; then usage; fi
  local label path d end flag worst=0 n=0
  printf '%-28s %-26s %6s  %s\n' CERTIFICATE EXPIRES DAYS STATUS
  while IFS='|' read -r label path; do
    n=$((n + 1))
    d=$(days_left "$path")
    end=$(openssl x509 -in "$path" -noout -enddate | cut -d= -f2)
    if (( d < 0 )); then flag="EXPIRED"; worst=2
    elif (( d <= warn )); then flag="RENEW (<= $warn days)"; worst=2
    else flag="ok"; fi
    printf '%-28s %-26s %6s  %s\n' "$label" "$end" "$d" "$flag"
  done < <(all_certs)
  (( n > 0 )) || { echo "No CA found in $CA_DIR or $DEVICE_CA_DIR" >&2; exit 1; }
  if (( worst == 2 )); then echo "Action needed: renew the certificates above (see ops/ca/README.md)." >&2; exit 2; fi
}

# Formats an epoch as YYYYMMDD (GNU date, then BSD/macOS date).
fmt_date() { date -u -d "@$1" +%Y%m%d 2>/dev/null || date -u -r "$1" +%Y%m%d; }

# One all-day reminder per certificate, 30 days before it expires.
cmd_ics() {
  local out="${1:-mes-cert-reminders.ics}" now label path d rem uid end tmp
  now=$(date +%s)
  tmp=$(mktemp)
  {
    echo "BEGIN:VCALENDAR"; echo "VERSION:2.0"; echo "PRODID:-//MES//certificate reminders//EN"; echo "CALSCALE:GREGORIAN"
    while IFS='|' read -r label path; do
      d=$(days_left "$path"); (( d >= 0 )) || continue
      rem=$(( d - 30 )); (( rem < 0 )) && rem=0
      uid=$(openssl x509 -in "$path" -noout -serial | cut -d= -f2)
      end=$(openssl x509 -in "$path" -noout -enddate | cut -d= -f2)
      echo "BEGIN:VEVENT"
      echo "UID:mes-cert-$uid@mes"
      echo "DTSTAMP:$(date -u +%Y%m%dT%H%M%SZ)"
      echo "DTSTART;VALUE=DATE:$(fmt_date $(( now + rem * 86400 )))"
      echo "SUMMARY:MES certificate renewal: $label"
      echo "DESCRIPTION:$label expires $end. Re-issue it and deploy (ops/ca/README.md). Run mes-ca.sh status to see all."
      echo "END:VEVENT"
    done < <(all_certs)
    echo "END:VCALENDAR"
  } > "$tmp"
  awk '{ printf "%s\r\n", $0 }' "$tmp" > "$out"   # RFC 5545 wants CRLF
  rm -f "$tmp"
  echo "Wrote $out ($(grep -c '^BEGIN:VEVENT' "$out") reminders). Import it into your calendar."
}

case "${1:-}" in
  init)         shift; cmd_init "$@" ;;
  issue)        shift; cmd_issue "$@" ;;
  init-device)  shift; cmd_init_device "$@" ;;
  issue-device) shift; cmd_issue_device "$@" ;;
  check)        shift; cmd_check "$@" ;;
  status)       shift; cmd_status "$@" ;;
  ics)          shift; cmd_ics "$@" ;;
  *)            usage ;;
esac

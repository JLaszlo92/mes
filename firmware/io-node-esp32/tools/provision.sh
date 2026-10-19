#!/usr/bin/env bash
# Writes the identity of one I/O node (Waveshare ESP32-S3-ETH-8DI-8RO) into its provisioning partition
# over USB, and optionally the firmware too. Run on the ADMIN laptop, with the bundle that
# ops/onboarding/new-edge-node.sh made for this node (it holds the node's private key).
#
#   provision.sh --bundle bundle-<name>.tar.gz --port <serial port> [options]
#
# Options:
#   --firmware <dir>        also flash the firmware from a release directory (bootloader.bin,
#                           partition-table.bin, ota_data_initial.bin, mes-io-node.bin) or a build/ directory
#   --tls-name <name>       name checked in the server certificates (default mes.pilot.internal: the SAN of
#                           the broker and nginx certificates; the URLs still use MES_HOST from the bundle)
#   --static-ip <a.b.c.d> --netmask <m> --gateway <g> [--dns <d>]   fixed address (default: DHCP)
#   --ntp <server>          NTP server (default: none; the backend's time and the RTC are the clock)
#   --inputs-active-high    only for a board whose inputs read high when active (the Waveshare board reads low)
#   --dry-run               build the image, show what would be flashed, flash nothing
#
# Needs: python3 with esptool and esp-idf-nvs-partition-gen   (pip3 install esptool esp-idf-nvs-partition-gen)
# The token is asked for (never on the command line, never echoed). Nothing secret stays on disk afterwards.
set -euo pipefail

die() { echo "ERROR: $*" >&2; exit 1; }

NVS_OFFSET=0x12000 # the "mescfg" partition in partitions.csv
NVS_SIZE=0x6000

bundle="" port="" firmware="" tls_name="mes.pilot.internal" ip="" netmask="" gateway="" dns="" ntp="" active_low=1 dry=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle) bundle="$2"; shift 2 ;;
    --port) port="$2"; shift 2 ;;
    --firmware) firmware="$2"; shift 2 ;;
    --tls-name) tls_name="$2"; shift 2 ;;
    --static-ip) ip="$2"; shift 2 ;;
    --netmask) netmask="$2"; shift 2 ;;
    --gateway) gateway="$2"; shift 2 ;;
    --dns) dns="$2"; shift 2 ;;
    --ntp) ntp="$2"; shift 2 ;;
    --inputs-active-high) active_low=0; shift ;;
    --dry-run) dry=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done
[[ -f "$bundle" ]] || die "--bundle <bundle-<name>.tar.gz> is required (made by ops/onboarding/new-edge-node.sh)"
[[ $dry -eq 1 || -n "$port" ]] || die "--port is required (macOS: ls /dev/cu.usbmodem*, Linux: ls /dev/ttyACM*)"
if [[ -n "$ip" ]]; then [[ -n "$netmask" && -n "$gateway" ]] || die "--static-ip needs --netmask and --gateway"; fi
for v in "$ip" "$netmask" "$gateway" "$dns"; do [[ -z "$v" || "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "not an IPv4 address: $v"; done
[[ "$tls_name" =~ ^[A-Za-z0-9.-]+$ ]] || die "bad --tls-name"
[[ -z "$ntp" || "$ntp" =~ ^[A-Za-z0-9.-]+$ ]] || die "bad --ntp"

PY="${PYTHON:-python3}"
"$PY" -m esptool version >/dev/null 2>&1 || die "esptool missing: pip3 install esptool"
"$PY" -c "import esp_idf_nvs_partition_gen" 2>/dev/null || die "esp-idf-nvs-partition-gen missing: pip3 install esp-idf-nvs-partition-gen"

umask 077
work="$(mktemp -d)"
cleanup() {
  # the work directory holds the private key and the token: overwrite before removing
  find "$work" -type f -exec sh -c 'dd if=/dev/zero of="$1" bs=1k count=$(( ($(wc -c <"$1") + 1023) / 1024 )) conv=notrunc 2>/dev/null' _ {} \; 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

tar xzf "$bundle" -C "$work"
dir="$(find "$work" -maxdepth 1 -type d -name 'bundle-*' | head -1)"
[[ -n "$dir" && -f "$dir/cert.pem" && -f "$dir/key.pem" && -f "$dir/mes-ca.crt" && -f "$dir/settings.env" ]] || die "not a bundle of new-edge-node.sh"
NODE_NAME="$(sed -n 's/^NODE_NAME=//p' "$dir/settings.env")"
MES_HOST="$(sed -n 's/^MES_HOST=//p' "$dir/settings.env")"
[[ "$NODE_NAME" =~ ^[a-z][a-z0-9-]{1,30}$ && "$MES_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || die "settings.env of the bundle is not valid"

# The same checks as install-on-node.sh: the certificate is this node's, not expired, and matches the key.
cn="$(openssl x509 -in "$dir/cert.pem" -noout -subject -nameopt multiline | sed -n 's/^ *commonName *= *//p')"
[[ "$cn" == "$NODE_NAME" ]] || die "the certificate is for '$cn', not '$NODE_NAME'"
openssl x509 -in "$dir/cert.pem" -noout -checkend 86400 >/dev/null || die "the certificate expires within a day (or has expired)"
[[ "$(openssl x509 -in "$dir/cert.pem" -noout -pubkey | openssl sha256)" == "$(openssl pkey -in "$dir/key.pem" -pubout | openssl sha256)" ]] \
  || die "cert.pem and key.pem do not belong together"
for f in cert.pem key.pem mes-ca.crt; do [[ $(wc -c <"$dir/$f") -lt 3900 ]] || die "$f is too large for the provisioning partition"; done

echo "Node:    $NODE_NAME"
echo "Backend: https://$MES_HOST   broker: mqtts://$MES_HOST:8884   certificate name checked: $tls_name"
echo "Address: ${ip:-DHCP}${ip:+ / $netmask, gateway $gateway${dns:+, DNS $dns}}"
echo
read -rsp "Edge node token (Admin -> Edge nodes, shown once; not echoed): " token; echo
[[ "$token" =~ ^[A-Za-z0-9_-]{16,150}$ ]] || die "that does not look like an edge node token"

csv="$work/nvs.csv"
{
  echo "key,type,encoding,value"
  echo "mes,namespace,,"
  echo "node_name,data,string,$NODE_NAME"
  echo "token,data,string,$token"
  echo "backend_url,data,string,https://$MES_HOST"
  echo "mqtt_url,data,string,mqtts://$MES_HOST:8884"
  echo "tls_name,data,string,$tls_name"
  echo "ca_pem,file,string,$dir/mes-ca.crt"
  echo "cert_pem,file,string,$dir/cert.pem"
  echo "key_pem,file,string,$dir/key.pem"
  echo "di_active_low,data,u8,$active_low"
  [[ -n "$ntp" ]] && echo "ntp_server,data,string,$ntp"
  if [[ -n "$ip" ]]; then
    echo "ip,data,string,$ip"; echo "netmask,data,string,$netmask"; echo "gateway,data,string,$gateway"
    [[ -n "$dns" ]] && echo "dns,data,string,$dns"
  fi
} >"$csv"
unset token
"$PY" -m esp_idf_nvs_partition_gen generate "$csv" "$work/mescfg.bin" "$NVS_SIZE" >/dev/null
echo "Provisioning image built ($(wc -c <"$work/mescfg.bin") bytes)."

args=("$NVS_OFFSET" "$work/mescfg.bin")
if [[ -n "$firmware" ]]; then
  find_bin() { for p in "$firmware/$1" "$firmware/bootloader/$1" "$firmware/partition_table/$1"; do [[ -f "$p" ]] && { echo "$p"; return; }; done; die "$1 not found in $firmware"; }
  args=(0x0 "$(find_bin bootloader.bin)" 0x8000 "$(find_bin partition-table.bin)" 0xf000 "$(find_bin ota_data_initial.bin)" \
        0x20000 "$(find_bin mes-io-node.bin)" "${args[@]}")
fi
if [[ $dry -eq 1 ]]; then
  echo "Dry run: would flash ${args[*]}"
  exit 0
fi
"$PY" -m esptool --chip esp32s3 -p "$port" -b 460800 --before default_reset --after hard_reset \
  write_flash --flash_mode dio --flash_size 16MB --flash_freq 80m "${args[@]}"

cat <<MSG

Done: $NODE_NAME is provisioned and restarts now.
  - Watch it boot:  $PY -m serial.tools.miniterm $port 115200   (the log shows the claim and "connected to broker")
  - Status LED: blue = no network, yellow = connecting / no lease, green = running, magenta = buffer over 80 %,
                red blinking = not provisioned; a short white flash = a part was counted.
  - Delete the bundle from this laptop now (it holds the private key).
MSG

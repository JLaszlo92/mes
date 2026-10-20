# I/O node firmware (Waveshare ESP32-S3-ETH-8DI-8RO)

The I/O version of the edge node: a DIN-rail box at the machine whose eight isolated digital inputs are wired
to the machine's signals (part pulses, a running/fault contact, a current switch). It replaces node-gate's
Node.js agent for this hardware and speaks the **same protocol**, so the backend, the dashboard and the
onboarding need no change: it is an ordinary edge node with **GPIO** channels.

Protocol gateways (Modbus, S7, OPC UA) stay on the TM-CP3B with the Node agent (`packages/edge-agent`).

## What it does (same as node-gate)

| | node-gate (`packages/edge-agent`) | I/O node |
|---|---|---|
| Claim, heartbeat every 30 s, release on a clean restart | yes | yes, same endpoints and bodies (+ `agentVersion`) |
| Rejected claim: ask again 5, 10, 20, 40, 60 s; give up after 150 s | exit 1, systemd restarts | reboot |
| Backend unreachable at start: run from the claim cache without a lease, claim in the background (v12) | yes | yes (`/data/claim-cache.json`, bound to the token's SHA-256, max 7 days) |
| Lost lease (heartbeat 4xx): keep collecting, claim again (v15) | yes | yes |
| Restart request / changed configuration seen on two heartbeats (v19) | exit 75 | release, reboot |
| MQTT with the device certificate on 8884, keepalive 15 s, connect timeout 10 s (v11) | yes | yes |
| Events buffered on disk, sent at once, resent after 15 s without an ack, at most 300 per 4 s sweep (v11) | yes | yes (on flash, see below) |
| Client certificate expiry in claim and heartbeat (v10) | yes | yes |
| Clock offset measured against the server (v7, v13) | corrects its stamps | **sets its clock** (it has no other time source) |
| Disk usage (v9) | yes | not sent: the backend's 2 GiB rule would always alarm on a 10 MB flash; a full buffer is reported as a `data_gap` instead |
| Catch-up of missed PLC counts (v5, v17) | yes | not needed: the box counts the pulses itself |

What is different because this is a microcontroller counting real pulses:

- **Collecting while the lease is refused.** After a power cut the old lease stays fresh for up to 90 s and the claim
  is answered with 409. node-gate starts no channel then (its PLC counters are caught up later); this box would lose
  those pulses, so it starts the channels from the claim cache and buffers, **but sends nothing until the lease is
  granted**. If the lease never comes (another box really owns the token), nothing is ever published.
- **No valid time yet.** With an empty RTC battery and no answer from the server, readings are kept in RAM with their
  monotonic time and stamped when the time is known, instead of being sent dated 1970 (node-gate's finding 37). Up to
  4096 per machine; beyond that the lost parts are reported as a `data_gap` (`clock_unknown`).
- **Flash buffer.** Segment files (32 KiB) that are only appended to and deleted, never rewritten; synced at most once a
  second; a power cut loses at most the last second. A line cut by a power cut is dropped when loaded. The buffer of
  each machine is limited (4 MB shared, the log shows the limit); when it is full the oldest events go and the lost
  parts are reported as a `data_gap` (`buffer_full`). At 1 part / 10 s per machine that is many hours of outage.
- **Removed channel.** The buffer of a channel that no longer exists is still sent (to its machine) and then deleted.
- **Relays** are switched off at boot and never used: the I/O node never drives the machine.

## Wiring and channels

The inputs are optocoupled and read **active** while current flows (the board reads low; `di_active_low`).
In Admin → Edge nodes, a channel of this node has protocol **GPIO** and its pins are the terminals:

| Field | Value | |
|---|---|---|
| Good pin / Scrap pin | `1`..`8` or `DI1`..`DI8` | a rising edge (inactive → active) is one part |
| Status pin | `1`..`8` / `DIx` | active = running, inactive = down (status bit mode) |
| Part filter (ms) | default 20 | a pulse shorter than this is noise |
| Status filter (ms) | default 1000 | the status input must hold this long; 2000-5000 for a current switch |
| Status mode | status bit / signal presence | signal presence: running while parts come, down after the no-signal timeout |
| Accept production while down | | as for node-gate |

`statusInvert: true` in the channel's connection config (API only) makes an active status input mean "down"
(e.g. a fault lamp). One input may serve several channels. The timestamps are those of the input edges, not of when
the firmware looked. For the first 15 minutes after a boot every raw input change is printed on the serial log
(`DI3 active`), and the LED flashes white for every counted part: the wiring can be checked without a laptop.

Status LED: **blue** no network · **yellow** connecting / no lease / no broker · **green** running ·
**magenta** a buffer is over 80 % · **red blinking** not provisioned.

## Adding a box (onboarding)

Steps 1-3 and 5 are those of `ops/onboarding/README.md` (certificate bundle, ACL entry, edge node in the UI with the
same name). Step 4 is USB instead of a shell:

```bash
pip3 install esptool esp-idf-nvs-partition-gen
firmware/io-node-esp32/tools/provision.sh --bundle bundle-io-hall1.tar.gz --port /dev/cu.usbmodem1101 \
    --firmware <release directory>          # leave out to change only the provisioning
```

It checks the certificate like `install-on-node.sh`, asks for the token, writes the node's own NVS partition
(`mescfg` at 0x12000: node name, token, `https://<MES_HOST>`, `mqtts://<MES_HOST>:8884`, CA, certificate, key) and
flashes it. The firmware image is the same for every box. Options: `--static-ip/--netmask/--gateway/--dns`,
`--ntp`, `--tls-name` (default `mes.pilot.internal`, the name in the server certificates). A brand-new board that is
not found on USB: hold **BOOT** while plugging it in.

Watch the boot: `python3 -m serial.tools.miniterm /dev/cu.usbmodem1101 115200`. The log uses node-gate's wording:
`claimed edge node, starting channels`, `connected to broker`, `machine status changed`, and every 10 minutes a
status line with the buffer of each machine.

## Building

ESP-IDF **v5.3.1**; nothing is downloaded during the build (LittleFS is vendored in `components/esp_littlefs`).

```bash
. ~/esp-idf/export.sh
cd firmware/io-node-esp32
idf.py set-target esp32s3      # once
idf.py build                   # build/mes-io-node.bin and the files provision.sh --firmware needs
```

The version is `PROJECT_VER` in `CMakeLists.txt` (`io-node-v2`); bump it with every release and tag the commit
`io-node-vN` on node-dc, like `edge-agent-vN`.

Layout: `components/mes_core` is the portable logic (debounce, status modes, buffer, retry, claim/heartbeat rules,
cache, event JSON) without ESP-IDF; `main/agent.c` the life cycle on top of `main/plat.h`; `main/hw.c`, `di.c`,
`net.c`, `prov.c` the board. `partitions.csv`: two app slots (a later over-the-air update needs no USB), `mescfg`
(provisioning), `storage` (9.9 MB LittleFS for the buffer).

## Tests

- **Unit tests of the core** on a PC: `make -C components/mes_core/test IDF_PATH=~/esp-idf` (1775 checks: the
  rules ported from node-gate, debounce, both status modes, the buffer with restarts, cut lines, full buffer and
  orphans, the claim/cache/heartbeat parsing).
- **End to end** with the real backend: `sim/` builds the same `agent.c` and core for Linux with a simulated board
  (inputs driven through a FIFO, libcurl, libmosquitto with the device certificate). See `sim/README.md`. Run on
  Oct 19, 2026 against the backend of this commit (Postgres 16, Mosquitto with mutual TLS): claim and channels,
  pulses and the 20 ms filter, status filter and production gate, signal presence timeout, `kill -9` with parts made
  during the 409 wait (buffered, booked with their real time after the lease came), broker outage, backend down at
  start (cache start, lease adopted), Restart agent button, changed channel setting (restart after two heartbeats, the
  new filter in use), lease taken
  by someone else (adopted after 90 s), removed channel with buffered events (delivered, buffer deleted), no RTC +
  clock 1 h behind + no backend (stamped correctly afterwards, offset 0), 800 parts in 48 s. No duplicates, no event
  with a wrong timestamp.
- **On the real board** (Oct 20, io-weiler): v1 booted, got its address by DHCP and crashed at its first claim — the
  claim handling needed 3.7 KB of stack on ESP-IDF's 3.5 KB main task (the Linux simulator has 8 MB, so it never
  showed). v2 runs the agent in its own 16 KB task, keeps the claim structures off the stack (largest frame now 624 B),
  gives the backend task 12 KB and the MQTT task 8 KB (TLS handshakes), and turns on stack canaries and the end-of-stack
  watchpoint; the 10-minute status line prints the unused stack of each task.
- **Not tested yet on the real board:** The pin map comes from the Waveshare wiki and its ESPHome configuration;
  check on the first box: Ethernet link and DHCP, the inputs (`DIx active` in the log while the input is energised),
  the RTC keeps the time over a power cut, a real power cut while counting.

## Security notes

The private key and the token are in the `mescfg` partition in plain form: whoever has the box and a USB cable can
read them (and clone the node until its certificate is removed from the ACL). The ESP32-S3 can prevent that with
**flash encryption + NVS encryption + secure boot**; these burn eFuses and **cannot be undone**, and a mistake can
make a board unusable. They are therefore not switched on by this firmware: decide it once the first boxes run, try it
on a spare board, and add it to the provisioning then (the `nvs_keys` partition is already reserved).

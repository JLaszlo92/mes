# 3-Raspberry-Pi test rig (physical GPIO wiring)

**Prefer a no-wiring first pass?** See `docs/pi-test-rig-s7-mode.md` — same
3-Pi rig, same edge agent and backend, but Pi #1 runs an S7 PLC simulator
and Pi #2 talks to it over the network instead of physical wires. Come
back here once that's working, if you also want to test the physical
discrete-I/O path.

This rig gives you a physical stand-in for a real shop-floor machine, without
needing one. Three Raspberry Pis, each playing one role in the real
architecture:

| Pi | Role | What runs on it |
|---|---|---|
| **Pi #1** | Virtual manufacturing machine | `virtual-machine/virtual_machine.py` — pulses GPIO outputs the way a real machine's discrete I/O would |
| **Pi #2** | Edge computer | `gpio_bridge.py` + `@mes/edge-agent` — reads the GPIO inputs, publishes MQTT events, buffers/retries |
| **Pi #3** | Backend computer | `@mes/backend` (+ PostgreSQL, Mosquitto) — the same stack from the walking-skeleton README, just running on a Pi instead of your laptop |

Nothing about the edge-agent or backend code changes for this — Pi #2 is
running the exact same `@mes/edge-agent` package as before, just with
`SIGNAL_SOURCE=gpio` instead of the default simulator. That's the point of
the `SignalSource` interface: the wiring below is the only new thing.

Wiring diagram: `docs/pi-test-rig-wiring.svg`

Everything below assumes all three Pis are already flashed, on the
network, and reachable over SSH. If you haven't done that part yet, see
`docs/pi-hardware-setup.md` first — it covers flashing the SD cards,
first boot, and getting SSH access, starting from nothing.

**Running plain Debian instead of Raspberry Pi OS?** Everything here works
the same way, with one exception: GPIO access. Raspberry Pi OS ships a
GPIO pin-factory library and udev permissions pre-configured out of the
box; plain Debian doesn't necessarily have either. Section 2 and 3 below
call this out at the point it matters (`gpiozero` install and the
`GPIOZERO_PIN_FACTORY` env var) — this is the one thing worth reading
even if you're skimming the rest as familiar.

## 0. Getting the code onto each Pi

You do this once per Pi, before any of the wiring or setup below. The
simplest approach: copy the **entire** `mes` folder to **all three** Pis —
don't try to figure out which files each one "needs." Pi #1 will just never
run `pnpm`, and Pi #3 will never run `virtual_machine.py`; the unused files
are harmless. This avoids a whole class of "wait, which folder goes where"
mistakes.

**Step 1 — get the code onto your Mac, unzipped.**

If you're starting from the `mes-pi-test-rig.zip` sent in this chat, save
it (e.g. to `~/Downloads`) and unzip it:

```bash
cd ~/Downloads
unzip mes-pi-test-rig.zip
```

You should now have a `~/Downloads/mes` folder. That's the thing you're
about to copy three times.

**Step 2 — find each Pi's IP address.**

SSH into each one from your Mac using whatever you used to confirm they're
reachable (hostname, `.local` mDNS name, or an IP from your router's client
list). If you don't already have all three addresses handy, on each Pi run:

```bash
hostname -I
```

That prints the Pi's IP address (the first one, if it lists more than one).
Write down which IP is which Pi — it's easy to mix them up once you're
copying files to three different addresses. If it helps, rename each Pi's
hostname to something obvious so you can SSH by name instead of tracking
IPs:

```bash
sudo hostnamectl set-hostname mes-pi1   # mes-pi2 / mes-pi3 on the others
sudo reboot
```

(On plain Debian, `<hostname>.local` resolution needs `avahi-daemon`
installed and running — `sudo apt install -y avahi-daemon` if
`ping mes-pi1.local` doesn't work after the rename. Otherwise just keep
using the IP from `hostname -I`.)

**Step 3 — copy the folder to each Pi, from your Mac's terminal.**

`scp -r` copies a whole folder over SSH. Run this three times, once per Pi,
swapping in that Pi's username and IP (whatever account you set up when
installing the OS on each Pi):

```bash
scp -r ~/Downloads/mes <username>@<pi1-ip>:~/mes
scp -r ~/Downloads/mes <username>@<pi2-ip>:~/mes
scp -r ~/Downloads/mes <username>@<pi3-ip>:~/mes
```

Each command will prompt for that Pi's password (or use your SSH key if
you've already set one up) and then copy the whole folder — this can take
a minute or two per Pi over Wi-Fi. When it finishes, SSH into each Pi and
confirm it landed:

```bash
ssh <username>@<pi1-ip>
ls ~/mes
# should list package.json, docs/, virtual-machine/, packages/, etc.
```

Do that check for all three Pis before moving on. From here, sections 1–4
below tell you exactly which commands to run on which Pi — you'll be
`cd ~/mes` on the right Pi for each one.

*(If `scp` gives you trouble — e.g. it can't resolve the Pi's address —
a USB stick works just as well: unzip onto the stick, plug it into each
Pi, and `cp -r /media/<stick>/mes ~/mes`.)*

## 1. Wiring (Pi #1 → Pi #2)

Only three signal wires plus a shared ground. **Never wire 5V — GPIO pins are
3.3V logic and a 5V signal will damage the Pi.**

| Signal | Pi #1 (BCM / physical pin) | Pi #2 (BCM / physical pin) |
|---|---|---|
| Good part pulse | GPIO17 / pin 11 (out) | GPIO5 / pin 29 (in) |
| Scrap part pulse | GPIO27 / pin 13 (out) | GPIO6 / pin 31 (in) |
| Machine status | GPIO22 / pin 15 (out) | GPIO13 / pin 33 (in) |
| Ground | any GND pin | any GND pin |

Put a **330Ω resistor in series on each of the three signal lines** (good,
scrap, status). GND is a direct wire, no resistor.

Pi #2's inputs are configured as **pull-down** (`pull_up=False` in
`gpio_bridge.py`). That means: HIGH = event/running, LOW = idle/down. This is
deliberate — if a wire comes loose or a connector fails, the input floats
low, which reads as "down"/"no part," the safe interpretation. A pull-up
convention would fail the opposite way (a disconnected wire silently reading
as "running"), which is worse for a system whose whole job is trusting the
signals it receives.

Power the two Pis from separate supplies (their own USB power) — just make
sure GND is common between them via the GND wire above, so both boards agree
on what "0V" means. Don't try to share power rails between boards.

## 2. Pi #1 — virtual manufacturing machine

SSH into Pi #1.

```bash
sudo apt update
sudo apt install -y python3-pip
pip install gpiozero lgpio --break-system-packages
```

(`lgpio` is the pin-factory library gpiozero uses to actually talk to the
GPIO character device — Raspberry Pi OS bundles a working default, plain
Debian generally doesn't, so this installs it explicitly rather than
relying on autodetection. Installing via `pip` here instead of `apt`
sidesteps guessing at Debian's exact package names, which vary by
release.)

If `python3 -c "import gpiozero; from gpiozero.pins.lgpio import
LGPIOFactory"` errors out on either Pi, see the troubleshooting section
below before continuing — it's much faster to fix this in isolation than
while also debugging wiring.

Using the `~/mes` copy from step 0:

```bash
cd ~/mes/virtual-machine
GPIOZERO_PIN_FACTORY=lgpio python3 virtual_machine.py
```

You should see nothing on stdout by default (it just drives the pins) — that's
expected. To confirm it's alive, check with a multimeter or LED across one of
the output pins and GND, or temporarily bump `LOG_LEVEL`-style prints in the
script if you want visual confirmation before wiring up Pi #2.

Tunable behavior via env vars (defaults shown):

```bash
AVG_CYCLE_SECONDS=3.0     # average time between parts
SCRAP_RATE=0.08           # fraction of parts that come out scrap
AVG_UPTIME_SECONDS=60.0   # average running stretch before a down event
DOWNTIME_SECONDS=10.0     # how long a down stretch lasts
PULSE_SECONDS=0.08        # how long each good/scrap pulse stays high
```

To have it start automatically on boot, install the provided systemd unit —
on plain Debian, add the `GPIOZERO_PIN_FACTORY=lgpio` line to it first:

```bash
sudo cp virtual-machine.service /etc/systemd/system/
sudo sed -i '/\[Service\]/a Environment=GPIOZERO_PIN_FACTORY=lgpio' /etc/systemd/system/virtual-machine.service
sudo systemctl daemon-reload
sudo systemctl enable --now virtual-machine
```

(See `virtual-machine/README.md` for the full rundown.)

## 3. Pi #2 — edge computer

SSH into Pi #2.

```bash
sudo apt update
sudo apt install -y python3-pip
pip install gpiozero lgpio --break-system-packages
```

(Same reasoning as Pi #1's install in Section 2 — see the note there if
you skipped it.)

You need Node.js (18+) and pnpm on this Pi to run `@mes/edge-agent`. If Pi #2
doesn't have them yet:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pnpm
```

Using the `~/mes` copy from step 0:

```bash
cd ~/mes
pnpm install
pnpm --filter @mes/shared build
pnpm --filter @mes/edge-agent build
```

Run the edge agent pointed at the GPIO bridge and at Pi #3's broker:

```bash
SIGNAL_SOURCE=gpio \
MACHINE_ID=pi-rig-01 \
MQTT_URL=mqtt://<pi3-ip>:1883 \
GPIOZERO_PIN_FACTORY=lgpio \
pnpm --filter @mes/edge-agent start
```

(`GPIOZERO_PIN_FACTORY=lgpio` is passed through to `gpio_bridge.py` as an
inherited environment variable — the edge agent doesn't need to know it's
there, it just spawns the bridge process with its own env attached. Not
needed if you're on Raspberry Pi OS with a working default pin factory
already, but harmless to include either way.)

If you wired to different pins than the defaults, override them:

```bash
GPIO_GOOD_PIN=5 GPIO_SCRAP_PIN=6 GPIO_STATUS_PIN=13   # these ARE the defaults — only needed if you wired differently
```

You should see a log line like:

```
edge agent started {"machineId":"pi-rig-01","topic":"machines/pi-rig-01/events","source":"gpio"}
```

and, once Pi #1 is pulsing, `part event` / `machine status changed` log
lines flowing as the wires toggle.

## 4. Pi #3 — backend computer

SSH into Pi #3. Install Node.js/pnpm the same way as above, plus PostgreSQL
and Mosquitto:

```bash
sudo apt update
sudo apt install -y postgresql mosquitto mosquitto-clients
sudo systemctl enable --now postgresql mosquitto
```

Create the database, then using the `~/mes` copy from step 0:

```bash
sudo -u postgres createuser --superuser mes 2>/dev/null || true
sudo -u postgres psql -c "ALTER USER mes WITH PASSWORD 'mes';"
sudo -u postgres createdb -O mes mes
cd ~/mes
pnpm install
pnpm --filter @mes/shared build
pnpm --filter @mes/backend build
```

Make sure Mosquitto is listening on the LAN, not just localhost — edit
`/etc/mosquitto/conf.d/mes.conf`:

```
listener 1883 0.0.0.0
allow_anonymous true
```

(`allow_anonymous true` is fine for a bench test rig; don't ship that config
to anything internet-facing — see PRD §8 on network segmentation and device
identity for what a production posture needs instead.)

```bash
sudo systemctl restart mosquitto
```

Run the migration once, then start the backend:

```bash
DATABASE_URL=postgres://mes:mes@localhost:5432/mes pnpm --filter @mes/backend migrate
DATABASE_URL=postgres://mes:mes@localhost:5432/mes MQTT_URL=mqtt://127.0.0.1:1883 pnpm --filter @mes/backend start
```

You should see the backend log its own MQTT connect, then (once Pi #2 is
publishing) events being persisted.

## 5. Dashboard (your laptop)

From your laptop, on the same network:

```bash
cd packages/frontend
VITE_BACKEND_WS_URL=ws://<pi3-ip>:3001 pnpm dev
```

Open the printed local URL — you should see live counts and status updates
as Pi #1 pulses through Pi #2 through Pi #3.

## 6. Verify in stages, not all at once

Debugging three Pis wired together at the same time is painful. Verify each
hop in isolation first:

**Pi #1 alone** — before wiring anything, run `virtual_machine.py` and
confirm with a multimeter/LED that the three output pins toggle.

**Pi #2's bridge alone** — before running the edge agent, run the bridge
script directly and manually jumper an input pin to 3.3V (through a
resistor) to confirm it prints a JSON line:

```bash
cd packages/edge-agent/python
GPIOZERO_PIN_FACTORY=lgpio python3 gpio_bridge.py
# touch GPIO5 to 3.3V (through the 330Ω resistor) — expect:
# {"kind": "production_count", "result": "good"}
```

**Pi #1 → Pi #2 wiring** — with both scripts above confirmed working
independently, wire them together and re-run `gpio_bridge.py` standalone —
you should see JSON lines appear on their own as Pi #1 runs, with no edge
agent or network involved yet.

**Pi #2 → Pi #3 → dashboard** — only once the GPIO hop is confirmed, bring
up the full edge agent, backend, and dashboard as in steps 3-5.

This is the same "isolate before you integrate" instinct as the
network-drop drill in the main README — it's much faster to find a problem
in one hop than to guess which of three hops it's in.

## 7. Troubleshooting

**No JSON lines from `gpio_bridge.py`, even after jumpering the pin** — check
you jumpered the exact BCM pin the script expects (5/6/13 by default, or
whatever you set via env vars), and that you're going through a resistor to
3.3V, not GND. Pull-down inputs read LOW at rest — a good jumper should flip
them HIGH.

**Edge agent logs `[gpio-bridge] failed to start`** — `python3` isn't on
Pi #2's PATH, or `gpiozero` isn't installed. Run `python3 -c "import
gpiozero"` on Pi #2 directly to confirm.

**`gpio_bridge.py`/`virtual_machine.py` crash with something like "no
compatible pin factory found" or a `PinFactoryFallback` warning followed
by an error** — this is the plain-Debian case Sections 2-3 flagged: no
working GPIO backend was found. Confirm `lgpio` is actually installed
(`python3 -c "import lgpio"` should print nothing and exit cleanly) and
that `GPIOZERO_PIN_FACTORY=lgpio` is actually set in the environment the
script runs in — easy to lose track of when it's set inline on one
command but the process was started a different way (systemd, a second
SSH session, etc).

**`gpio_bridge.py`/`virtual_machine.py` crash with a permission error
touching `/dev/gpiochip0`** — on Raspberry Pi OS your user is
pre-added to a `gpio` group with the right udev permissions; plain
Debian usually isn't set up that way out of the box. Fastest fix for a
bench rig — run the script with `sudo` (prefix the `python3`/`pnpm`
command). The more correct fix, if you'd rather not run as root long-term:

```bash
sudo groupadd -f gpio
sudo usermod -aG gpio "$USER"
echo 'SUBSYSTEM=="gpio", KERNEL=="gpiochip*", GROUP="gpio", MODE="0660"' | sudo tee /etc/udev/rules.d/99-gpio.rules
sudo udevadm control --reload-rules && sudo udevadm trigger
```

then log out and back in (group membership only takes effect on a new
session) before trying again.

**Events show up in edge-agent logs but never reach the backend/dashboard**
— check `MQTT_URL` on Pi #2 actually points at Pi #3's IP (not
`127.0.0.1`), and that Mosquitto on Pi #3 is bound to `0.0.0.0:1883` (see
step 4) and not blocked by a firewall (`sudo ufw status` if ufw is active).

**Backend never gets events even though MQTT looks connected on both ends**
— this is the exact failure mode the ack-based delivery logic in
`packages/edge-agent/src/index.ts` was built to survive. Give it ~4 seconds
— the retry sweep will republish anything unacked. If it's still stuck
after that, check the backend actually subscribed (its startup log) before
Pi #2 connected.

**Pi #1's pulses look "stuck" or erratic** — `PULSE_SECONDS` (default 0.08s)
needs to be comfortably longer than Pi #2's `BOUNCE_SECONDS` (default 0.02s)
for `gpio_bridge.py`'s debouncing to register it cleanly. Don't set
`PULSE_SECONDS` below ~0.05s.

## 8. Safety notes (recap)

- Only wire GPIO signal pins and GND between the two boards — never 5V.
- 330Ω series resistor on every signal line; GND is a direct wire.
- Pull-down inputs on Pi #2: a disconnected or broken wire reads "down,"
  never a false "running." Keep this convention if you extend the rig.
- Separate power supplies per Pi; GND is the only thing they need to share.

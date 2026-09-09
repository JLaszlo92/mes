# Setting up the three Raspberry Pis (from a blank SD card)

This is the step before `docs/pi-test-rig-s7-mode.md` or
`docs/pi-test-rig.md` — getting all three Pis flashed, booted, and
reachable over SSH from your Mac. Once you're at the point where you can
SSH into all three, skip to whichever test-rig doc you're using; both
assume you're starting from here.

Do this once per Pi (three times total). It's the same process each
time — only the hostname you pick differs.

**Already have all three Pis on plain Debian instead of Raspberry Pi OS,
with SSH working?** Then you're already past everything in this file —
go straight to `docs/pi-test-rig-s7-mode.md` (recommended first) or
`docs/pi-test-rig.md`. The one place the OS choice matters is GPIO access
in the physical-wiring mode, which those docs call out at the point it's
relevant.

## What you need

- 3 Raspberry Pis (any model with a 40-pin header — Pi 3B+, 4, or 5 all
  work fine for this; a Pi Zero 2 W works too but is tighter on RAM for
  Pi #3's backend role)
- 3 microSD cards, 16GB or larger, plus a way to write to them from your
  Mac (a USB-SD adapter if your Mac doesn't have a card slot)
- Power supplies for each Pi
- Network access for all three — Wi-Fi is fine for all of this; you don't
  need Ethernet
- Your Mac, with the free **Raspberry Pi Imager** app: download from
  [raspberrypi.com/software](https://www.raspberrypi.com/software/)

You do **not** need a monitor, keyboard, or mouse for any of this — the
Imager app can pre-configure SSH, Wi-Fi, and login credentials before the
Pi ever boots, so setup is entirely headless from your Mac.

## 1. Decide the three roles and hostnames now

Pick names that tell you at a glance which Pi is which — you'll be typing
these a lot over the next few docs:

| Pi | Suggested hostname | Role |
|---|---|---|
| Pi #1 | `mes-pi1` | The "machine" — PLC simulator (S7 mode) or virtual machine (GPIO mode) |
| Pi #2 | `mes-pi2` | Edge computer — runs `@mes/edge-agent` |
| Pi #3 | `mes-pi3` | Backend — runs Postgres, Mosquitto, `@mes/backend` |

Naming them this way means you can reach each one as `mes-pi1.local`,
`mes-pi2.local`, `mes-pi3.local` on your network without ever having to
look up an IP address (Raspberry Pi OS runs mDNS/Avahi by default, which
is what makes the `.local` name work). If your network doesn't support
`.local` names for some reason, Section 5 below covers finding IPs
directly.

## 2. Flash each SD card with Raspberry Pi Imager

Repeat this whole section three times — once per Pi/SD card, using that
Pi's hostname from the table above.

1. Put the SD card in your Mac (via adapter if needed) and open Raspberry
   Pi Imager.
2. **Choose Device** → pick your Pi model (or "No filtering" if unsure).
3. **Choose OS** → **Raspberry Pi OS (other)** → **Raspberry Pi OS Lite
   (64-bit)**. The Lite (no desktop) version is the right choice — all
   three Pis run headless services, no GUI needed, and Lite boots faster
   and leaves more RAM for the actual test rig.
4. **Choose Storage** → select your SD card. Double-check you've picked
   the right device here — this step erases the card.
5. Click **Next**. When prompted "Would you like to apply OS
   customisation settings?", click **Edit Settings** (this is the step
   that makes the whole setup headless):
   - **General tab:**
     - Hostname: `mes-pi1` (or `mes-pi2` / `mes-pi3` — whichever this
       card is for)
     - Username and password: pick something you'll remember; you'll use
       this to SSH in. Avoid the old default `pi`/`raspberry` combination
       for anything reachable on a real network.
     - Configure wireless LAN: enter your Wi-Fi network name and
       password (skip this if you're using Ethernet instead).
   - **Services tab:**
     - Enable SSH → **Use password authentication** (or set up a key pair
       here if you already use SSH keys — either works).
   - Click **Save**.
6. Back at the "apply customisation settings?" prompt, click **Yes**,
   then confirm you want to erase and write the card.
7. Wait for it to finish writing and verifying (a few minutes), then move
   the card to the next one — repeat for all three, changing only the
   hostname each time.

## 3. Boot each Pi

Put each SD card in its Pi, connect power, and wait about 60-90 seconds
for the first boot (it's doing more setup than usual on the very first
boot — resizing the filesystem, applying the settings from step 2, etc).
There's nothing to watch for since there's no monitor attached — just give
it the time.

Do this for all three Pis before moving on, so you're not context-
switching between "which Pi is still booting."

## 4. SSH in and confirm each one

From your Mac's terminal:

```bash
ssh <username>@mes-pi1.local
ssh <username>@mes-pi2.local
ssh <username>@mes-pi3.local
```

using the username you set in step 2. The first connection to each will
show an SSH host-key prompt (`Are you sure you want to continue
connecting?`) — type `yes`. Once in, a quick sanity check:

```bash
hostname       # should print mes-pi1 (or pi2/pi3)
hostname -I    # prints its IP address, if you want it for later
```

If `mes-pi1.local` doesn't resolve at all, see the troubleshooting section
below before assuming something's wrong with the Pi itself — it's usually
a network/mDNS issue, not a bad flash.

## 5. If `.local` names don't work on your network

Some routers or networks (especially some corporate/guest Wi-Fi setups)
block or don't support mDNS. If so, find each Pi's IP directly instead:

- Check your router's admin page for a list of connected devices — look
  for `mes-pi1`, `mes-pi2`, `mes-pi3` by name.
- Or, once you've gotten into a Pi by any means once, `hostname -I` on
  that Pi prints its own IP.

From then on, use the IP in place of `<hostname>.local` everywhere in this
guide and the test-rig docs, e.g. `ssh pi@192.168.1.42` instead of
`ssh pi@mes-pi1.local`.

It's worth setting a DHCP reservation for each Pi in your router's admin
page once you know their IPs (so each Pi always gets the same address) —
otherwise an IP can change after a reboot or a long time offline, which
is annoying once you've got `PLC_IP`/`MQTT_URL`/etc. pointing at specific
addresses in the test-rig setup.

## 6. Update each Pi (recommended, one time)

While you're in each one:

```bash
sudo apt update && sudo apt full-upgrade -y
sudo reboot
```

This isn't strictly required to run the test rig, but starting from an
up-to-date OS avoids chasing down bugs that are actually just an outdated
package. Give it a minute to come back up after the reboot before SSHing
in again.

## 7. Next: get the actual test-rig code onto each Pi

You're now at the point where `docs/pi-test-rig-s7-mode.md` Section 0 (or
`docs/pi-test-rig.md` Section 0) picks up — copying the `mes` project
folder from your Mac onto each Pi via `scp`. Use the hostnames or IPs from
this guide wherever those docs say `<pi1-ip>`, `<pi2-ip>`, `<pi3-ip>`.

Start with the S7 mode (`docs/pi-test-rig-s7-mode.md`) if you haven't
already — no physical wiring, fastest path to a working end-to-end test.

## Troubleshooting

**`ssh: Could not resolve hostname mes-pi1.local`** — either the Pi hasn't
finished booting yet (give it another minute), or your network doesn't
support mDNS (see Section 5). Try `ping mes-pi1.local` first — if that
doesn't resolve either, it's a network issue, not SSH specifically.

**SSH prompts for a password you don't recognize, or password auth is
refused** — double check you're using the username you set in Imager's
customisation screen, not `pi` (Raspberry Pi OS no longer creates that
default account when you set a custom username during flashing).

**Wi-Fi never connects (Pi doesn't show up on the network at all)** —
double-check the SSID and password entered in step 2 exactly (Wi-Fi
passwords are case-sensitive), and confirm the Pi model you flashed for
actually has Wi-Fi hardware — older Pi models or certain "compute
module"-style boards may need Ethernet instead. If your network uses
5GHz-only Wi-Fi, note that some older Pi models (e.g. Pi 3B, non-plus) are
2.4GHz-only.

**You skipped the "Edit Settings" step in Imager by accident** — you'll
end up with a Pi that boots to a login prompt with no SSH enabled and a
default `pi`/`raspberry` login (or no default login at all, on newer OS
images). Easiest fix: re-flash the card with Imager, this time clicking
**Edit Settings** before writing. If you'd rather not re-flash, you can
also connect a keyboard/monitor once to enable SSH via
`sudo raspi-config` → Interface Options → SSH, but re-flashing is faster
in practice.

**Need to start over on one Pi** — SD cards are cheap to re-flash; if
anything about a Pi's setup feels wrong, it's usually faster to re-flash
that one card from scratch (repeat Section 2 for it) than to debug a
half-configured system.

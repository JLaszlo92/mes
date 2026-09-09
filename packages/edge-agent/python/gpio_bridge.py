#!/usr/bin/env python3
"""
Runs on Pi #2 (the edge Pi), spawned as a child process by
GpioSignalSource.ts — see ../src/signal-sources/GpioSignalSource.ts. Reads
the three physical GPIO inputs wired from Pi #1 (the virtual machine, see
../../../virtual-machine/virtual_machine.py) and prints one JSON line per
event to stdout. That's the entire contract with the Node side: this
script knows about GPIO, GpioSignalSource.ts knows about JSON lines,
neither knows about the other's internals.

Why Python here and TypeScript everywhere else: gpiozero is the
Raspberry-Pi-maintained abstraction over GPIO access, and it transparently
handles the differences between Pi models (notably Pi 5's different GPIO
chip) that would otherwise require pinning down exact chip/line numbers by
hand. That cross-model robustness was worth a second language for this one
hardware-facing script, the same way plain `pg` was worth dropping an ORM
for the database layer — see the root README's "stack decisions" section
for the same reasoning applied there.

Inputs use pull-down resistors (pull_up=False): a disconnected or
unpowered wire reads LOW, which this script and virtual_machine.py both
treat as the "safe" state (down / no part), not a false positive.

Environment variables (all optional, defaults shown):
    GOOD_PIN=5 SCRAP_PIN=6 STATUS_PIN=13
    BOUNCE_SECONDS=0.02
"""
import json
import os
from signal import pause

from gpiozero import Button, DigitalInputDevice

GOOD_PIN = int(os.environ.get("GOOD_PIN", 5))
SCRAP_PIN = int(os.environ.get("SCRAP_PIN", 6))
STATUS_PIN = int(os.environ.get("STATUS_PIN", 13))
BOUNCE_SECONDS = float(os.environ.get("BOUNCE_SECONDS", 0.02))


def emit(obj: dict) -> None:
    """The entire interface to the Node side: one JSON object per line."""
    print(json.dumps(obj), flush=True)


def build_devices():
    good = Button(GOOD_PIN, pull_up=False, bounce_time=BOUNCE_SECONDS)
    scrap = Button(SCRAP_PIN, pull_up=False, bounce_time=BOUNCE_SECONDS)
    status = DigitalInputDevice(STATUS_PIN, pull_up=False, bounce_time=BOUNCE_SECONDS)

    good.when_pressed = lambda: emit({"kind": "production_count", "result": "good"})
    scrap.when_pressed = lambda: emit({"kind": "production_count", "result": "scrap"})
    status.when_activated = lambda: emit({"kind": "machine_status", "status": "running"})
    status.when_deactivated = lambda: emit({"kind": "machine_status", "status": "down"})

    return good, scrap, status


def main() -> None:
    _good, _scrap, status = build_devices()
    # Announce the current status immediately on startup so the edge agent
    # (and everything downstream of it) isn't "blind" until the next
    # transition happens on the wire.
    emit({"kind": "machine_status", "status": "running" if status.is_active else "down"})
    pause()


if __name__ == "__main__":
    main()

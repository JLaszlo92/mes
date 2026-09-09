#!/usr/bin/env python3
"""
Runs on Pi #1 in the 3-Pi test rig (see ../docs/pi-test-rig.md). Drives three
GPIO output pins to stand in for a real machine's discrete signals:

  - GOOD_PIN:   pulses HIGH briefly for each good part
  - SCRAP_PIN:  pulses HIGH briefly for each scrap part
  - STATUS_PIN: HIGH while "running", LOW while "down"

All three default LOW/inactive. That polarity is deliberate, not arbitrary:
the edge Pi's inputs (gpio_bridge.py) use pull-down resistors, so a
disconnected or unpowered wire reads as LOW too — meaning a wiring fault
fails toward "down", never toward a false "running", matching the
fail-safe spirit of PRD Section 8's robustness requirements even in this
test-rig stand-in for a real machine connection.

Timing mirrors packages/edge-agent/src/signal-sources/SimulatedSignalSource.ts
so this behaves like the software simulator it's replacing — same average
cycle time, same scrap rate, same downtime pattern — just over real wires
instead of an in-process callback.

Usage:
    python3 virtual_machine.py
Environment variables (all optional, defaults shown):
    GOOD_PIN=17 SCRAP_PIN=27 STATUS_PIN=22
    AVG_CYCLE_SECONDS=3.0 SCRAP_RATE=0.08
    AVG_UPTIME_SECONDS=60.0 DOWNTIME_SECONDS=10.0
    PULSE_SECONDS=0.08
"""
import os
import random
import threading
import time

from gpiozero import DigitalOutputDevice

GOOD_PIN = int(os.environ.get("GOOD_PIN", 17))
SCRAP_PIN = int(os.environ.get("SCRAP_PIN", 27))
STATUS_PIN = int(os.environ.get("STATUS_PIN", 22))

AVG_CYCLE_SECONDS = float(os.environ.get("AVG_CYCLE_SECONDS", 3.0))
SCRAP_RATE = float(os.environ.get("SCRAP_RATE", 0.08))
AVG_UPTIME_SECONDS = float(os.environ.get("AVG_UPTIME_SECONDS", 60.0))
DOWNTIME_SECONDS = float(os.environ.get("DOWNTIME_SECONDS", 10.0))
PULSE_SECONDS = float(os.environ.get("PULSE_SECONDS", 0.08))

good = DigitalOutputDevice(GOOD_PIN, initial_value=False)
scrap = DigitalOutputDevice(SCRAP_PIN, initial_value=False)
status = DigitalOutputDevice(STATUS_PIN, initial_value=False)

stop_event = threading.Event()


def log(message: str) -> None:
    print(f"[virtual-machine] {message}", flush=True)


def pulse(pin: DigitalOutputDevice, label: str) -> None:
    pin.on()
    time.sleep(PULSE_SECONDS)
    pin.off()
    log(f"pulsed {label}")


def part_cycle_loop() -> None:
    while not stop_event.is_set():
        jitter = random.uniform(0.5, 1.5)
        time.sleep(AVG_CYCLE_SECONDS * jitter)
        if stop_event.is_set():
            break
        if random.random() < SCRAP_RATE:
            pulse(scrap, "scrap")
        else:
            pulse(good, "good")


def downtime_cycle_loop() -> None:
    while not stop_event.is_set():
        jitter = random.uniform(0.6, 1.4)
        time.sleep(AVG_UPTIME_SECONDS * jitter)
        if stop_event.is_set():
            break
        status.off()
        log("status -> down")
        time.sleep(DOWNTIME_SECONDS)
        if stop_event.is_set():
            break
        status.on()
        log("status -> running")


def main() -> None:
    log(
        f"starting — good=GPIO{GOOD_PIN} scrap=GPIO{SCRAP_PIN} "
        f"status=GPIO{STATUS_PIN}"
    )
    status.on()
    log("status -> running (initial)")

    threads = [
        threading.Thread(target=part_cycle_loop, daemon=True),
        threading.Thread(target=downtime_cycle_loop, daemon=True),
    ]
    for t in threads:
        t.start()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        log("shutting down…")
        stop_event.set()
        good.off()
        scrap.off()
        status.off()


if __name__ == "__main__":
    main()

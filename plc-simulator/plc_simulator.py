#!/usr/bin/env python3
"""
Simulates a Siemens S7 PLC's outputs using python-snap7's server role, so
Pi #2's edge agent (via edge-agent/python/s7_bridge.py) can exercise the S7
protocol path over a real S7comm network connection with zero physical
wiring. See docs/pi-test-rig-s7-mode.md — this is meant as the easy first
pass; the GPIO rig in docs/pi-test-rig.md is the physical-wiring follow-up
once this path works end to end.

python-snap7 3.x is pure Python (no libsnap7 C library / apt package
needed) — `pip install python-snap7` is the whole install, on any platform
including a Raspberry Pi's ARM Linux. That's a meaningfully simpler
dependency than the old ctypes-wrapping snap7 bindings, and is why this
mode was worth adding as the "no wiring" first pass: it's genuinely less
setup than the GPIO rig, not just less physical work.

Data layout (DB1) — must match edge-agent/python/s7_bridge.py:
  byte 0, bit 0 : Running     (BOOL)  1 = running, 0 = down
  bytes 4-7     : GoodCount   (DINT)  cumulative good parts
  bytes 8-11    : ScrapCount  (DINT)  cumulative scrap parts

The counters only ever increase, mirroring how a real PLC's production
counters behave — s7_bridge.py is the piece that turns "counter went up by
N" into N discrete production_count events, the same way a real OPC-UA or
Modbus adapter will have to.
"""
import os
import random
import threading
import time

AVG_CYCLE_SECONDS = float(os.environ.get("AVG_CYCLE_SECONDS", 3.0))
SCRAP_RATE = float(os.environ.get("SCRAP_RATE", 0.08))
AVG_UPTIME_SECONDS = float(os.environ.get("AVG_UPTIME_SECONDS", 60.0))
DOWNTIME_SECONDS = float(os.environ.get("DOWNTIME_SECONDS", 10.0))
DB_NUMBER = int(os.environ.get("DB_NUMBER", 1))
DB_SIZE = int(os.environ.get("DB_SIZE", 16))
TCP_PORT = int(os.environ.get("TCP_PORT", 102))


def encode_state(buffer: bytearray, running: bool, good: int, scrap: int) -> None:
    """Pure, testable: writes the three values into the DB buffer at their
    documented offsets. No snap7 server/network dependency — this is what
    tests/test_plc_simulator.py exercises directly with a plain bytearray."""
    from snap7.util import set_bool, set_dint

    set_bool(buffer, 0, 0, running)
    set_dint(buffer, 4, good)
    set_dint(buffer, 8, scrap)


def part_cycle_loop(buffer: bytearray, state: dict, stop: threading.Event) -> None:
    """Mirrors virtual_machine.py's timing model (jittered inter-arrival
    time, a scrap rate) so behavior is comparable whether you're running
    the GPIO rig or this S7 rig — only the wire format downstream differs."""
    while not stop.is_set():
        time.sleep(max(0.1, random.expovariate(1 / AVG_CYCLE_SECONDS)))
        if stop.is_set():
            return
        if not state["running"]:
            continue
        if random.random() < SCRAP_RATE:
            state["scrap"] += 1
        else:
            state["good"] += 1
        encode_state(buffer, state["running"], state["good"], state["scrap"])


def downtime_cycle_loop(buffer: bytearray, state: dict, stop: threading.Event) -> None:
    while not stop.is_set():
        time.sleep(max(1.0, random.expovariate(1 / AVG_UPTIME_SECONDS)))
        if stop.is_set():
            return
        state["running"] = False
        encode_state(buffer, False, state["good"], state["scrap"])
        time.sleep(DOWNTIME_SECONDS)
        if stop.is_set():
            return
        state["running"] = True
        encode_state(buffer, True, state["good"], state["scrap"])


def main() -> None:
    import snap7

    buffer = bytearray(DB_SIZE)
    state = {"running": True, "good": 0, "scrap": 0}
    encode_state(buffer, True, 0, 0)

    server = snap7.Server()
    server.register_area(snap7.SrvArea.DB, DB_NUMBER, buffer)
    server.start(tcp_port=TCP_PORT)
    print(f"S7 PLC simulator listening on :{TCP_PORT}, DB{DB_NUMBER} ({DB_SIZE} bytes)", flush=True)

    stop = threading.Event()
    threading.Thread(target=part_cycle_loop, args=(buffer, state, stop), daemon=True).start()
    threading.Thread(target=downtime_cycle_loop, args=(buffer, state, stop), daemon=True).start()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        server.stop()
        server.destroy()


if __name__ == "__main__":
    main()

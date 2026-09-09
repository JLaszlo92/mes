#!/usr/bin/env python3
"""
Polls a Siemens S7 PLC (or plc-simulator/plc_simulator.py's stand-in for
one) over the network via S7comm and turns counter deltas into the same
newline-JSON SignalReading contract gpio_bridge.py uses — see
S7SignalSource.ts and docs/pi-test-rig-s7-mode.md. Same downstream
consumer either way: edge-agent/src/index.ts doesn't know or care whether
a reading came from a GPIO pulse or an S7 poll.

Why polling+diffing instead of push events: S7 (like Modbus and most PLC
protocols) is a request/response memory-read protocol, not pub/sub — a PLC
doesn't "send" a good-part event, it just holds a counter that goes up.
So the model here is deliberately different from gpio_bridge.py's
edge-triggered pulses: read the PLC's cumulative GoodCount/ScrapCount/
Running values on a fixed interval, and turn any observed increase since
the last poll into that many discrete production_count events. A real
OPC-UA or Modbus adapter (PRD Section 5.5, ROADMAP M1) will follow this
same polling+diffing shape, not the GPIO one — this is a genuine dry run
of that pattern, not just a placeholder.

Data layout (DB1) — must match plc-simulator/plc_simulator.py:
  byte 0, bit 0 : Running     (BOOL)  1 = running, 0 = down
  bytes 4-7     : GoodCount   (DINT)  cumulative good parts
  bytes 8-11    : ScrapCount  (DINT)  cumulative scrap parts
"""
import json
import os
import sys
import time

from snap7.util import get_bool, get_dint

PLC_IP = os.environ.get("PLC_IP", "127.0.0.1")
PLC_RACK = int(os.environ.get("PLC_RACK", 0))
PLC_SLOT = int(os.environ.get("PLC_SLOT", 1))
PLC_PORT = int(os.environ.get("PLC_PORT", 102))
DB_NUMBER = int(os.environ.get("DB_NUMBER", 1))
DB_SIZE = int(os.environ.get("DB_SIZE", 16))
POLL_INTERVAL_SECONDS = float(os.environ.get("POLL_INTERVAL_MS", 300)) / 1000.0
RECONNECT_DELAY_SECONDS = float(os.environ.get("RECONNECT_DELAY_SECONDS", 3.0))


def decode_state(buffer: bytes) -> dict:
    """Pure: decode the raw DB bytes into a plain dict. No network calls —
    this is what tests/test_s7_bridge.py exercises directly with synthetic
    buffers, without needing a live PLC connection or the snap7 Client."""
    return {
        "running": get_bool(buffer, 0, 0),
        "good": get_dint(buffer, 4),
        "scrap": get_dint(buffer, 8),
    }


def diff_events(previous: dict, current: dict) -> list:
    """Pure: compare two decoded states and return the list of
    SignalReading-shaped dicts the transition implies. Counters only ever
    go up (see plc_simulator.py) — a decrease is treated as a counter
    reset/restart and ignored rather than emitting a negative count."""
    events = []

    good_delta = current["good"] - previous["good"]
    if good_delta > 0:
        events.extend([{"kind": "production_count", "result": "good"}] * good_delta)

    scrap_delta = current["scrap"] - previous["scrap"]
    if scrap_delta > 0:
        events.extend([{"kind": "production_count", "result": "scrap"}] * scrap_delta)

    if current["running"] != previous["running"]:
        events.append({"kind": "machine_status", "status": "running" if current["running"] else "down"})

    return events


def emit(event: dict) -> None:
    print(json.dumps(event), flush=True)


def main() -> None:
    # Imported here, not at module top, so decode_state/diff_events stay
    # importable and unit-testable even in an environment that somehow
    # lacks snap7 — see python/tests/test_s7_bridge.py.
    import snap7

    client = snap7.Client()
    previous = {"running": False, "good": 0, "scrap": 0}
    first_poll = True

    while True:
        try:
            client.connect(PLC_IP, PLC_RACK, PLC_SLOT, tcp_port=PLC_PORT)
            print(f"[s7-bridge] connected to PLC at {PLC_IP}:{PLC_PORT}", file=sys.stderr, flush=True)
            while True:
                raw = client.db_read(DB_NUMBER, 0, DB_SIZE)
                current = decode_state(raw)
                if first_poll:
                    # Announce the starting status without replaying every
                    # count that happened before this bridge was started.
                    emit({"kind": "machine_status", "status": "running" if current["running"] else "down"})
                    first_poll = False
                else:
                    for event in diff_events(previous, current):
                        emit(event)
                previous = current
                time.sleep(POLL_INTERVAL_SECONDS)
        except Exception as exc:  # noqa: BLE001 - broad on purpose: any
            # connection problem here means "retry," never "crash the bridge."
            print(
                f"[s7-bridge] connection lost or failed ({exc}); retrying in {RECONNECT_DELAY_SECONDS}s",
                file=sys.stderr,
                flush=True,
            )
            try:
                client.disconnect()
            except Exception:
                pass
            time.sleep(RECONNECT_DELAY_SECONDS)


if __name__ == "__main__":
    main()

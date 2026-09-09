#!/usr/bin/env python3
"""
Verifies plc_simulator.py's pure state-encoding logic and the part/downtime
cycle threads' behavior over a short run, without starting a real snap7
server. encode_state() only touches a plain bytearray via snap7.util, so
it's testable directly; the cycle loops are exercised with the module's
timing constants patched down to milliseconds so the test finishes fast
while still exercising real thread interleaving.

Run from plc-simulator/:
    python3 -m pytest tests/test_plc_simulator.py -q
"""
import os
import sys
import threading
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from snap7.util import get_bool, get_dint  # noqa: E402

import plc_simulator  # noqa: E402


def test_encode_state_writes_documented_offsets():
    buf = bytearray(16)
    plc_simulator.encode_state(buf, running=True, good=12, scrap=3)
    assert get_bool(buf, 0, 0) is True
    assert get_dint(buf, 4) == 12
    assert get_dint(buf, 8) == 3

    plc_simulator.encode_state(buf, running=False, good=12, scrap=3)
    assert get_bool(buf, 0, 0) is False


def test_part_cycle_loop_increments_counts_while_running(monkeypatch):
    monkeypatch.setattr(plc_simulator, "AVG_CYCLE_SECONDS", 0.01)
    monkeypatch.setattr(plc_simulator, "SCRAP_RATE", 0.0)  # deterministic: every part is good

    buffer = bytearray(16)
    state = {"running": True, "good": 0, "scrap": 0}
    stop = threading.Event()

    thread = threading.Thread(target=plc_simulator.part_cycle_loop, args=(buffer, state, stop), daemon=True)
    thread.start()
    time.sleep(0.2)
    stop.set()
    thread.join(timeout=1)

    assert state["good"] > 0
    assert state["scrap"] == 0
    assert get_dint(buffer, 4) == state["good"]


def test_part_cycle_loop_does_not_count_while_down(monkeypatch):
    monkeypatch.setattr(plc_simulator, "AVG_CYCLE_SECONDS", 0.01)

    buffer = bytearray(16)
    state = {"running": False, "good": 0, "scrap": 0}
    stop = threading.Event()

    thread = threading.Thread(target=plc_simulator.part_cycle_loop, args=(buffer, state, stop), daemon=True)
    thread.start()
    time.sleep(0.1)
    stop.set()
    thread.join(timeout=1)

    assert state["good"] == 0
    assert state["scrap"] == 0


if __name__ == "__main__":
    import pytest

    raise SystemExit(pytest.main([__file__, "-v"]))

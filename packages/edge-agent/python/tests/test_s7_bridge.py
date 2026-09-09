#!/usr/bin/env python3
"""
Verifies s7_bridge.py's decode/diff logic without any real PLC connection —
decode_state() and diff_events() are pure functions with no snap7.Client
dependency, so they're testable with plain synthetic byte buffers. This
cannot verify an actual S7comm network round-trip end to end (that's
covered by the manual smoke-test steps in docs/pi-test-rig-s7-mode.md);
what it verifies is the part that's easy to get subtly wrong: byte
offsets, delta math, and not double-counting or emitting on a decrease.

Run from packages/edge-agent/python/:
    python3 -m pytest tests/test_s7_bridge.py -q
or, without pytest installed:
    python3 tests/test_s7_bridge.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from snap7.util import set_bool, set_dint  # noqa: E402

import s7_bridge  # noqa: E402


def make_buffer(running: bool, good: int, scrap: int) -> bytearray:
    buf = bytearray(16)
    set_bool(buf, 0, 0, running)
    set_dint(buf, 4, good)
    set_dint(buf, 8, scrap)
    return buf


def test_decode_state_reads_documented_offsets():
    buf = make_buffer(running=True, good=42, scrap=7)
    assert s7_bridge.decode_state(buf) == {"running": True, "good": 42, "scrap": 7}


def test_decode_state_down_status():
    buf = make_buffer(running=False, good=0, scrap=0)
    assert s7_bridge.decode_state(buf)["running"] is False


def test_diff_events_emits_one_good_event_per_unit_increase():
    previous = {"running": True, "good": 10, "scrap": 2}
    current = {"running": True, "good": 13, "scrap": 2}
    events = s7_bridge.diff_events(previous, current)
    assert events == [{"kind": "production_count", "result": "good"}] * 3


def test_diff_events_emits_scrap_and_good_together():
    previous = {"running": True, "good": 10, "scrap": 2}
    current = {"running": True, "good": 11, "scrap": 3}
    events = s7_bridge.diff_events(previous, current)
    assert events.count({"kind": "production_count", "result": "good"}) == 1
    assert events.count({"kind": "production_count", "result": "scrap"}) == 1
    assert len(events) == 2


def test_diff_events_emits_status_change():
    previous = {"running": True, "good": 5, "scrap": 0}
    current = {"running": False, "good": 5, "scrap": 0}
    events = s7_bridge.diff_events(previous, current)
    assert events == [{"kind": "machine_status", "status": "down"}]


def test_diff_events_no_change_emits_nothing():
    state = {"running": True, "good": 5, "scrap": 1}
    assert s7_bridge.diff_events(state, dict(state)) == []


def test_diff_events_ignores_a_decrease_no_negative_counts():
    # A counter reset/restart (e.g. the simulator or a real PLC rebooting)
    # must never produce a negative-count event.
    previous = {"running": True, "good": 50, "scrap": 5}
    current = {"running": True, "good": 3, "scrap": 0}
    events = s7_bridge.diff_events(previous, current)
    assert events == []


if __name__ == "__main__":
    import pytest

    raise SystemExit(pytest.main([__file__, "-v"]))

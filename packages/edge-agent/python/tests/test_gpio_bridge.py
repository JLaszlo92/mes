#!/usr/bin/env python3
"""
Verifies gpio_bridge.py's event logic without any real Raspberry Pi
hardware, using gpiozero's own mock pin factory. This cannot verify the
physical wiring (nothing can, short of a real Pi rig) — what it does
verify is that the right JSON line comes out for the right electrical
event, which is the part that's actually easy to get subtly wrong (wrong
polarity, wrong debounce, wrong key names).

Run from packages/edge-agent/python/:
    GPIOZERO_PIN_FACTORY=mock python3 -m pytest tests/test_gpio_bridge.py -q
or, without pytest installed:
    GPIOZERO_PIN_FACTORY=mock python3 tests/test_gpio_bridge.py
"""
import importlib
import io
import json
import os
import sys
import time
from contextlib import redirect_stdout
from pathlib import Path

os.environ.setdefault("GPIOZERO_PIN_FACTORY", "mock")
os.environ["GOOD_PIN"] = "5"
os.environ["SCRAP_PIN"] = "6"
os.environ["STATUS_PIN"] = "13"
os.environ["BOUNCE_SECONDS"] = "0"  # no debounce delay in tests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def _reload_bridge():
    import gpio_bridge  # noqa: E402

    return importlib.reload(gpio_bridge)


def _mock_pin(pin_factory, bcm_number):
    return pin_factory.pin(bcm_number)


def _read_emitted_lines(buf: io.StringIO):
    return [json.loads(line) for line in buf.getvalue().splitlines() if line.strip()]


def test_good_pulse_emits_good_count():
    bridge = _reload_bridge()
    from gpiozero import Device

    good, scrap, status = bridge.build_devices()
    buf = io.StringIO()
    with redirect_stdout(buf):
        _mock_pin(Device.pin_factory, 5).drive_high()
        time.sleep(0.01)
        _mock_pin(Device.pin_factory, 5).drive_low()
        time.sleep(0.01)

    events = _read_emitted_lines(buf)
    assert {"kind": "production_count", "result": "good"} in events, events


def test_scrap_pulse_emits_scrap_count():
    bridge = _reload_bridge()
    from gpiozero import Device

    good, scrap, status = bridge.build_devices()
    buf = io.StringIO()
    with redirect_stdout(buf):
        _mock_pin(Device.pin_factory, 6).drive_high()
        time.sleep(0.01)
        _mock_pin(Device.pin_factory, 6).drive_low()
        time.sleep(0.01)

    events = _read_emitted_lines(buf)
    assert {"kind": "production_count", "result": "scrap"} in events, events


def test_status_transitions_emit_running_and_down():
    bridge = _reload_bridge()
    from gpiozero import Device

    good, scrap, status = bridge.build_devices()
    buf = io.StringIO()
    with redirect_stdout(buf):
        _mock_pin(Device.pin_factory, 13).drive_high()
        time.sleep(0.01)
        _mock_pin(Device.pin_factory, 13).drive_low()
        time.sleep(0.01)

    events = _read_emitted_lines(buf)
    assert {"kind": "machine_status", "status": "running"} in events, events
    assert {"kind": "machine_status", "status": "down"} in events, events


def test_disconnected_wire_reads_as_down_not_running():
    """Pull-down inputs: an idle/disconnected status pin must read LOW
    (down), never HIGH (running) — the fail-safe property described in
    virtual_machine.py's module docstring."""
    bridge = _reload_bridge()

    _good, _scrap, status = bridge.build_devices()
    assert status.is_active is False


if __name__ == "__main__":
    tests = [
        test_good_pulse_emits_good_count,
        test_scrap_pulse_emits_scrap_count,
        test_status_transitions_emit_running_and_down,
        test_disconnected_wire_reads_as_down_not_running,
    ]
    failures = 0
    for test in tests:
        try:
            test()
            print(f"PASS  {test.__name__}")
        except AssertionError as exc:
            failures += 1
            print(f"FAIL  {test.__name__}: {exc}")
    sys.exit(1 if failures else 0)

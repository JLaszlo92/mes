"""End-to-end run of s7_bridge.main() against a scripted fake PLC."""
import contextlib
import importlib
import io
import json
import os
import struct
import sys
import tempfile
import time
import types
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))


def _install_fake_snap7():
    """The real python-snap7 is used when installed; otherwise a minimal stand-in."""
    try:
        import snap7  # noqa: F401
        import snap7.util  # noqa: F401
        return
    except ImportError:
        pass
    snap7 = types.ModuleType("snap7")
    util = types.ModuleType("snap7.util")
    util.get_bool = lambda buf, byte, bit: bool((buf[byte] >> bit) & 1)
    util.get_dint = lambda buf, off: struct.unpack(">i", bytes(buf[off:off + 4]))[0]
    snap7.util = util
    snap7.Client = object
    sys.modules["snap7"] = snap7
    sys.modules["snap7.util"] = util


_install_fake_snap7()


class Stop(BaseException):
    """Ends the bridge's endless loop; not an Exception, so the bridge cannot swallow it."""


def frame(running, good, scrap):
    buf = bytearray(16)
    buf[0] = 1 if running else 0
    buf[4:8] = struct.pack(">i", good)
    buf[8:12] = struct.pack(">i", scrap)
    return bytes(buf)


class FakePlc:
    """Each script item is a frame (bytes) or an Exception to raise from db_read."""

    def __init__(self, script):
        self.script = list(script)

    def connect(self, *args, **kwargs):
        pass

    def disconnect(self):
        pass

    def db_read(self, *args, **kwargs):
        if not self.script:
            raise Stop()
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def run_bridge(script, state_file="", max_age_s="600"):
    env = {
        "COUNTER_STATE_FILE": state_file,
        "CATCHUP_MAX_AGE_SECONDS": max_age_s,
        "POLL_INTERVAL_MS": "1",
        "RECONNECT_DELAY_SECONDS": "0",
    }
    out, err = io.StringIO(), io.StringIO()
    with mock.patch.dict(os.environ, env):
        sys.modules.pop("s7_bridge", None)
        bridge = importlib.import_module("s7_bridge")
        plc = FakePlc(script)
        with mock.patch("snap7.Client", lambda: plc, create=True), mock.patch.object(bridge.time, "sleep", lambda s: None):
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                try:
                    bridge.main()
                except Stop:
                    pass
    events = [json.loads(line) for line in out.getvalue().splitlines() if line.strip()]
    return events, err.getvalue()


def parts(events, result):
    return sum(1 for e in events if e.get("kind") == "production_count" and e.get("result") == result)


class S7CatchupTest(unittest.TestCase):
    def write_state(self, tmp, good, scrap, ago_s):
        path = os.path.join(tmp, "counters.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump({"good": good, "scrap": scrap, "seenAtMs": int((time.time() - ago_s) * 1000)}, handle)
        return path

    def test_restart_books_the_gap(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self.write_state(tmp, 100, 10, 70)
            events, err = run_bridge([frame(True, 135, 11), frame(True, 136, 11)], path)
            self.assertEqual(parts(events, "good"), 36)  # 35 caught up + 1 live
            self.assertEqual(parts(events, "scrap"), 1)
            self.assertEqual(events[0], {"kind": "machine_status", "status": "running"})
            self.assertIn("booked 35 good", err)
            with open(path, encoding="utf-8") as handle:
                self.assertEqual(json.load(handle)["good"], 136)

    def test_restart_after_too_long_drops_and_warns(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self.write_state(tmp, 100, 10, 20 * 60)
            events, err = run_bridge([frame(True, 135, 11)], path)
            self.assertEqual(parts(events, "good"), 0)
            self.assertIn("NOT booked", err)

    def test_dropped_gap_is_reported_as_a_data_gap_event(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self.write_state(tmp, 100, 10, 20 * 60)
            events, _ = run_bridge([frame(True, 135, 11)], path)
            gaps = [e for e in events if e.get("kind") == "data_gap"]
            self.assertEqual(len(gaps), 1)
            self.assertEqual(gaps[0]["reason"], "too_old")
            self.assertEqual((gaps[0]["lostGood"], gaps[0]["lostScrap"]), (35, 1))
            self.assertAlmostEqual(gaps[0]["gapSeconds"], 20 * 60, delta=10)

    def test_booked_gap_has_no_data_gap_event(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self.write_state(tmp, 100, 10, 70)
            events, _ = run_bridge([frame(True, 135, 11)], path)
            self.assertEqual([e for e in events if e.get("kind") == "data_gap"], [])

    def test_catchup_switched_off_reports_disabled(self):
        events, _ = run_bridge([frame(True, 10, 0), ConnectionError("plc gone"), frame(True, 14, 1)], max_age_s="0")
        gaps = [e for e in events if e.get("kind") == "data_gap"]
        self.assertEqual(len(gaps), 1)
        self.assertEqual((gaps[0]["reason"], gaps[0]["lostGood"], gaps[0]["lostScrap"]), ("disabled", 4, 1))

    def test_first_ever_start_has_no_burst(self):
        with tempfile.TemporaryDirectory() as tmp:
            events, _ = run_bridge([frame(True, 5000, 40)], os.path.join(tmp, "new.json"))
            self.assertEqual(parts(events, "good"), 0)
            self.assertTrue(os.path.exists(os.path.join(tmp, "new.json")))

    def test_link_loss_in_process_is_caught_up(self):
        events, _ = run_bridge([frame(True, 10, 0), ConnectionError("plc gone"), frame(True, 14, 1)])
        self.assertEqual(parts(events, "good"), 4)
        self.assertEqual(parts(events, "scrap"), 1)
        statuses = [e["status"] for e in events if e["kind"] == "machine_status"]
        self.assertEqual(statuses, ["running", "down", "running"])

    def test_link_loss_with_catchup_switched_off_is_dropped(self):
        events, err = run_bridge([frame(True, 10, 0), ConnectionError("plc gone"), frame(True, 14, 1)], max_age_s="0")
        self.assertEqual(parts(events, "good"), 0)
        self.assertIn("NOT booked", err)

    def test_unwritable_state_file_does_not_stop_counting(self):
        with tempfile.TemporaryDirectory() as tmp:
            blocker = os.path.join(tmp, "file")
            open(blocker, "w").close()
            events, err = run_bridge([frame(True, 1, 0), frame(True, 3, 0)], os.path.join(blocker, "sub", "c.json"))
            self.assertEqual(parts(events, "good"), 2)
            self.assertIn("could not save counter state", err)

    def test_counter_going_backwards_restarts_from_current(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self.write_state(tmp, 500, 5, 30)
            events, _ = run_bridge([frame(True, 3, 0), frame(True, 4, 0)], path)
            self.assertEqual(parts(events, "good"), 1)


if __name__ == "__main__":
    unittest.main()

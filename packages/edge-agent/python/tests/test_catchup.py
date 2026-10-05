import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from catchup import MAX_CATCHUP_PARTS, describe_plan, load_counter_state, plan_catchup, save_counter_state  # noqa: E402

MIN = 60_000
NOW = 1_800_000_000_000


def stored(good, scrap, ago_ms):
    return {"good": good, "scrap": scrap, "seenAtMs": NOW - ago_ms}


class PlanCatchupTest(unittest.TestCase):
    def test_first_start(self):
        plan = plan_catchup(None, {"good": 500, "scrap": 3}, NOW, 10 * MIN)
        self.assertEqual(plan["note"], "first_start")
        self.assertEqual(plan["emit"], {"good": 0, "scrap": 0})

    def test_short_gap_is_booked(self):
        plan = plan_catchup(stored(1000, 10, 70_000), {"good": 1035, "scrap": 11}, NOW, 10 * MIN)
        self.assertEqual(plan["note"], "caught_up")
        self.assertEqual(plan["emit"], {"good": 35, "scrap": 1})

    def test_limit_is_inclusive(self):
        self.assertEqual(plan_catchup(stored(0, 0, 10 * MIN), {"good": 5, "scrap": 0}, NOW, 10 * MIN)["note"], "caught_up")
        plan = plan_catchup(stored(0, 0, 10 * MIN + 1), {"good": 5, "scrap": 0}, NOW, 10 * MIN)
        self.assertEqual(plan["note"], "too_old")
        self.assertEqual(plan["lost"], {"good": 5, "scrap": 0})

    def test_no_gap(self):
        self.assertEqual(plan_catchup(stored(7, 1, 180 * MIN), {"good": 7, "scrap": 1}, NOW, 10 * MIN)["note"], "no_gap")

    def test_counter_reset(self):
        plan = plan_catchup(stored(1000, 10, 1000), {"good": 3, "scrap": 0}, NOW, 10 * MIN)
        self.assertEqual(plan["note"], "counter_reset")
        self.assertEqual(plan["emit"], {"good": 0, "scrap": 0})

    def test_disabled(self):
        plan = plan_catchup(stored(10, 0, 1000), {"good": 20, "scrap": 0}, NOW, 0)
        self.assertEqual(plan["note"], "disabled")
        self.assertEqual(plan["lost"], {"good": 10, "scrap": 0})

    def test_clock_set_back(self):
        self.assertEqual(plan_catchup(stored(10, 0, -5000), {"good": 12, "scrap": 0}, NOW, 10 * MIN)["note"], "clock_back")

    def test_too_large(self):
        plan = plan_catchup(stored(0, 0, 1000), {"good": MAX_CATCHUP_PARTS + 1, "scrap": 0}, NOW, 10 * MIN)
        self.assertEqual(plan["note"], "too_large")
        self.assertEqual(plan_catchup(stored(0, 0, 1000), {"good": MAX_CATCHUP_PARTS, "scrap": 0}, NOW, 10 * MIN)["note"], "caught_up")


class StateFileTest(unittest.TestCase):
    def test_round_trip_and_corruption(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "sub", "c.json")
            self.assertIsNone(load_counter_state(path))
            save_counter_state(path, 12, 3, 99)
            self.assertEqual(load_counter_state(path), {"good": 12, "scrap": 3, "seenAtMs": 99})
            with open(path, "w", encoding="utf-8") as handle:
                handle.write("{broken")
            self.assertIsNone(load_counter_state(path))
            with open(path, "w", encoding="utf-8") as handle:
                handle.write('{"good": -1, "scrap": 0, "seenAtMs": 1}')
            self.assertIsNone(load_counter_state(path))

    def test_empty_path_means_no_persistence(self):
        self.assertIsNone(load_counter_state(""))
        self.assertIsNone(load_counter_state(None))

    def test_describe(self):
        self.assertIsNone(describe_plan(plan_catchup(stored(1, 0, 1), {"good": 1, "scrap": 0}, NOW, MIN)))
        self.assertIn("NOT booked", describe_plan(plan_catchup(stored(1, 0, 20 * MIN), {"good": 9, "scrap": 0}, NOW, MIN)))


if __name__ == "__main__":
    unittest.main()

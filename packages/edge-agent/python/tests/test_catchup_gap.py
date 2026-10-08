import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from catchup import dropped_gap, plan_catchup  # noqa: E402

MIN = 60_000
NOW = 1_800_000_000_000


def stored(good, scrap, ago_ms):
    return {"good": good, "scrap": scrap, "seenAtMs": NOW - ago_ms}


class DroppedGapTest(unittest.TestCase):
    def test_too_old(self):
        plan = plan_catchup(stored(100, 5, 25 * MIN), {"good": 220, "scrap": 8}, NOW, 10 * MIN)
        self.assertEqual(dropped_gap(plan), {"reason": "too_old", "gapSeconds": 1500, "lostGood": 120, "lostScrap": 3})

    def test_clock_back_has_a_negative_length(self):
        plan = plan_catchup(stored(100, 5, -5 * MIN), {"good": 110, "scrap": 5}, NOW, 10 * MIN)
        self.assertEqual(dropped_gap(plan), {"reason": "clock_back", "gapSeconds": -300, "lostGood": 10, "lostScrap": 0})

    def test_too_large_and_disabled(self):
        self.assertEqual(dropped_gap(plan_catchup(stored(0, 0, MIN), {"good": 6000, "scrap": 0}, NOW, 10 * MIN))["reason"], "too_large")
        gap = dropped_gap(plan_catchup(stored(0, 0, MIN), {"good": 4, "scrap": 1}, NOW, 0))
        self.assertEqual((gap["reason"], gap["lostGood"], gap["lostScrap"]), ("disabled", 4, 1))

    def test_nothing_to_report_when_booked_or_nothing_lost(self):
        self.assertIsNone(dropped_gap(plan_catchup(stored(100, 5, 2 * MIN), {"good": 110, "scrap": 5}, NOW, 10 * MIN)))  # caught_up
        self.assertIsNone(dropped_gap(plan_catchup(stored(100, 5, 30 * MIN), {"good": 100, "scrap": 5}, NOW, 10 * MIN)))  # no_gap
        self.assertIsNone(dropped_gap(plan_catchup(None, {"good": 5, "scrap": 0}, NOW, 10 * MIN)))  # first_start
        self.assertIsNone(dropped_gap(plan_catchup(stored(100, 5, MIN), {"good": 3, "scrap": 0}, NOW, 10 * MIN)))  # counter_reset


if __name__ == "__main__":
    unittest.main()

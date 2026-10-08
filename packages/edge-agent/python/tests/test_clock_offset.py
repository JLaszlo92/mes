import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from clock_offset import ClockOffset  # noqa: E402


class FakeMonotonic:
    def __init__(self):
        self.now = 100.0

    def __call__(self):
        return self.now


class ClockOffsetTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, "clock-offset")
        self.clock = FakeMonotonic()

    def tearDown(self):
        self.dir.cleanup()

    def write(self, text):
        with open(self.path, "w", encoding="utf-8") as handle:
            handle.write(text)

    def make(self, initial=0, path=None):
        return ClockOffset(initial, self.path if path is None else path, 1.0, self.clock)

    def test_without_a_file_path_it_is_the_initial_value(self):
        self.assertEqual(self.make(5000, path="").get(), 5000)

    def test_missing_file_keeps_the_initial_value(self):
        self.assertEqual(self.make(7000).get(), 7000)

    def test_reads_the_file_on_the_first_call(self):
        self.write("300051")
        self.assertEqual(self.make(0).get(), 300051)

    def test_negative_and_float_text(self):
        self.write("-120000")
        self.assertEqual(self.make().get(), -120000)
        self.write("2500.0\n")
        self.clock.now += 5
        offset = self.make()
        self.assertEqual(offset.get(), 2500)

    def test_rereads_at_most_once_per_second(self):
        self.write("1000")
        offset = self.make()
        self.assertEqual(offset.get(), 1000)
        self.write("2000")
        self.clock.now += 0.5
        self.assertEqual(offset.get(), 1000)
        self.clock.now += 0.5
        self.assertEqual(offset.get(), 2000)

    def test_garbage_or_a_vanished_file_keeps_the_last_value(self):
        self.write("1000")
        offset = self.make()
        self.assertEqual(offset.get(), 1000)
        self.write("not a number")
        self.clock.now += 2
        self.assertEqual(offset.get(), 1000)
        os.remove(self.path)
        self.clock.now += 2
        self.assertEqual(offset.get(), 1000)
        self.write("")
        self.clock.now += 2
        self.assertEqual(offset.get(), 1000)


if __name__ == "__main__":
    unittest.main()

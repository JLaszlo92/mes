"""The clock correction the edge agent measured against the server, as seen by the S7 bridge.

The agent writes the correction (milliseconds to add to this device's clock) to a small file whenever it
changes; the bridge re-reads it about once a second, so a changed correction needs no restart. If the
file is missing or unreadable the last known value is kept (initially the value from the environment).
"""
import time


class ClockOffset:
    def __init__(self, initial_ms=0, path="", reread_seconds=1.0, monotonic=time.monotonic):
        self._offset_ms = int(initial_ms)
        self._path = path
        self._reread_seconds = reread_seconds
        self._monotonic = monotonic
        self._read_at = None

    def get(self):
        if self._path:
            now = self._monotonic()
            if self._read_at is None or now - self._read_at >= self._reread_seconds:
                self._read_at = now
                try:
                    with open(self._path, "r", encoding="utf-8") as handle:
                        self._offset_ms = int(float(handle.read().strip()))
                except (OSError, ValueError):
                    pass  # keep the last known value
        return self._offset_ms

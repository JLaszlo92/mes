"""Counter catch-up for the bridge scripts (mirror of src/catchup.ts).

When a bridge reads a PLC's cumulative counters for the first time after a
gap in observation (the bridge or the edge agent restarted, or the PLC link
was lost), the parts produced meanwhile are booked afterwards - but only for
a short gap (default 10 minutes). Event timestamps are the time of emission,
so crediting a long gap would put the parts into the wrong hour and shift.
Longer gaps are dropped and reported.

Pure functions plus a tiny JSON file helper; no snap7 import, so this is
unit-testable anywhere (python/tests/test_catchup.py).
"""
import json
import os

# Above this many parts in one catch-up, a wrong register is more likely than real production.
MAX_CATCHUP_PARTS = 5000

_ZERO = {"good": 0, "scrap": 0}


def plan_catchup(stored, current, now_ms, max_age_ms):
    """stored: None or {"good", "scrap", "seenAtMs"}; current: {"good", "scrap", ...}.
    Returns {"emit": {...}, "lost": {...}, "note": str, "age_ms": int|None}."""
    if stored is None:
        return {"emit": dict(_ZERO), "lost": dict(_ZERO), "note": "first_start", "age_ms": None}

    age_ms = now_ms - stored["seenAtMs"]

    if current["good"] < stored["good"] or current["scrap"] < stored["scrap"]:
        return {"emit": dict(_ZERO), "lost": dict(_ZERO), "note": "counter_reset", "age_ms": age_ms}

    delta = {"good": current["good"] - stored["good"], "scrap": current["scrap"] - stored["scrap"]}
    if delta["good"] == 0 and delta["scrap"] == 0:
        return {"emit": dict(_ZERO), "lost": dict(_ZERO), "note": "no_gap", "age_ms": age_ms}

    if max_age_ms <= 0:
        return {"emit": dict(_ZERO), "lost": delta, "note": "disabled", "age_ms": age_ms}
    # A negative age means the clock was set back: the length of the gap is unknown.
    if age_ms < 0:
        return {"emit": dict(_ZERO), "lost": delta, "note": "clock_back", "age_ms": age_ms}
    if age_ms > max_age_ms:
        return {"emit": dict(_ZERO), "lost": delta, "note": "too_old", "age_ms": age_ms}
    if delta["good"] + delta["scrap"] > MAX_CATCHUP_PARTS:
        return {"emit": dict(_ZERO), "lost": delta, "note": "too_large", "age_ms": age_ms}

    return {"emit": delta, "lost": dict(_ZERO), "note": "caught_up", "age_ms": age_ms}


def _valid_count(value):
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def load_counter_state(path):
    """Returns the stored state, or None when the file is missing or corrupt."""
    if not path:
        return None
    try:
        with open(path, "r", encoding="utf-8") as handle:
            value = json.load(handle)
        if _valid_count(value.get("good")) and _valid_count(value.get("scrap")) and _valid_count(value.get("seenAtMs")):
            return {"good": value["good"], "scrap": value["scrap"], "seenAtMs": value["seenAtMs"]}
    except (OSError, ValueError, AttributeError):
        pass
    return None


def save_counter_state(path, good, scrap, now_ms):
    """Atomic: write a temp file next to the target, then rename over it."""
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump({"good": good, "scrap": scrap, "seenAtMs": now_ms}, handle)
    os.replace(tmp, path)


def describe_plan(plan):
    """One log line for the plan, or None when there is nothing to say."""
    age = None if plan["age_ms"] is None else round(plan["age_ms"] / 1000)
    note = plan["note"]
    if note == "caught_up":
        return f"catch-up: booked {plan['emit']['good']} good / {plan['emit']['scrap']} scrap produced while not observed (gap {age}s)"
    if note in ("too_old", "clock_back", "too_large", "disabled"):
        return (
            f"catch-up: {plan['lost']['good']} good / {plan['lost']['scrap']} scrap produced while not observed "
            f"were NOT booked ({note}, gap {age}s)"
        )
    if note == "counter_reset":
        return "catch-up: a counter went backwards (PLC restart?); starting from the current values"
    if note == "first_start":
        return "catch-up: no earlier counter values known; starting from the current ones"
    return None

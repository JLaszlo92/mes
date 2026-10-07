import { describe, expect, it } from "vitest";
import type { MachineEvent } from "@mes/shared";
import { RetryTracker } from "../retry-tracker.js";

const ev = (id: string): MachineEvent => ({ machineId: "m1", timestamp: "2026-10-07T13:00:00.000Z", sourceEventId: id, type: "machine_status", status: "running" }) as unknown as MachineEvent;
const ids = (list: MachineEvent[]) => list.map((e) => e.sourceEventId);

describe("RetryTracker", () => {
  it("sends a bounded portion per sweep, oldest first, and the rest on the next sweeps", () => {
    let now = 1000;
    const tracker = new RetryTracker(15_000, 3, () => now);
    const pending = ["a", "b", "c", "d", "e"].map(ev);
    expect(ids(tracker.select(pending))).toEqual(["a", "b", "c"]);
    now += 4000;
    expect(ids(tracker.select(pending))).toEqual(["d", "e"]);
    now += 4000;
    expect(tracker.select(pending)).toEqual([]);
  });

  it("sends an unacknowledged event again only after the minimum age", () => {
    let now = 0;
    const tracker = new RetryTracker(15_000, 300, () => now);
    const pending = [ev("a")];
    expect(ids(tracker.select(pending))).toEqual(["a"]);
    now = 14_999;
    expect(tracker.select(pending)).toEqual([]);
    now = 15_000;
    expect(ids(tracker.select(pending))).toEqual(["a"]);
  });

  it("forgets what was sent on reset (a new connection)", () => {
    const tracker = new RetryTracker(15_000, 300, () => 0);
    const pending = [ev("a"), ev("b")];
    expect(tracker.select(pending)).toHaveLength(2);
    expect(tracker.select(pending)).toHaveLength(0);
    tracker.reset();
    expect(ids(tracker.select(pending))).toEqual(["a", "b"]);
  });

  it("does not hold on to acknowledged events", () => {
    let now = 0;
    const tracker = new RetryTracker(15_000, 300, () => now);
    tracker.select([ev("a"), ev("b")]);
    now = 1000;
    tracker.select([ev("b")]); // "a" was acked and left the buffer
    now = 2000;
    // "a" returning to the buffer (same id, e.g. after a crash) is treated as new
    expect(ids(tracker.select([ev("a"), ev("b")]))).toEqual(["a"]);
  });
});

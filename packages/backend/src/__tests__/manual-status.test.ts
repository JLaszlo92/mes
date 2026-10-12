import { describe, expect, it } from "vitest";
import { decideCount, decideSignal } from "../manual-status.js";

const setAt = "2026-10-12T10:00:00.000Z";
const later = "2026-10-12T10:05:00.000Z";
const free = { setAt, blocksProduction: false };
const blocking = { setAt, blocksProduction: true };

describe("decideSignal", () => {
  it("applies everything when no manual status is active", () => {
    expect(decideSignal(undefined, { status: "down", timestamp: setAt })).toBe("apply");
  });
  it("keeps a buffered event older than the manual status as history only", () => {
    expect(decideSignal(free, { status: "running", timestamp: "2026-10-12T09:59:00.000Z" })).toBe("history");
    expect(decideSignal(blocking, { status: "down", timestamp: setAt })).toBe("history");
  });
  it("a running signal ends a manual status that does not block production", () => {
    expect(decideSignal(free, { status: "running", timestamp: "2026-10-12T10:00:01.000Z" })).toBe("apply_and_end");
  });
  it("a running signal is only a signal while the manual status blocks production", () => {
    expect(decideSignal(blocking, { status: "running", timestamp: later })).toBe("suppress");
  });
  it("any other newer signal is kept as a signal while the manual status holds", () => {
    expect(decideSignal(free, { status: "down", timestamp: later })).toBe("suppress");
    expect(decideSignal(blocking, { status: "idle", timestamp: later })).toBe("suppress");
  });
});

describe("decideCount", () => {
  it("counts as always without a manual status", () => {
    expect(decideCount(undefined, { timestamp: later })).toBe("apply");
  });
  it("a part made before the manual status counts", () => {
    expect(decideCount(blocking, { timestamp: "2026-10-12T09:59:00.000Z" })).toBe("apply");
  });
  it("a part ends a non-blocking manual status and counts", () => {
    expect(decideCount(free, { timestamp: later })).toBe("count_and_run");
  });
  it("a part under a blocking manual status is not counted", () => {
    expect(decideCount(blocking, { timestamp: later })).toBe("block");
  });
});

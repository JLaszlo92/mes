import { describe, expect, it } from "vitest";
import { decideSignal } from "../manual-status.js";

const setAt = "2026-10-12T10:00:00.000Z";

describe("decideSignal", () => {
  it("applies everything when no manual status is active", () => {
    expect(decideSignal(undefined, { status: "down", timestamp: setAt })).toBe("apply");
  });
  it("keeps a buffered event older than the manual status as history only", () => {
    expect(decideSignal({ setAt }, { status: "running", timestamp: "2026-10-12T09:59:00.000Z" })).toBe("history");
    expect(decideSignal({ setAt }, { status: "down", timestamp: setAt })).toBe("history");
  });
  it("a running signal ends the manual status", () => {
    expect(decideSignal({ setAt }, { status: "running", timestamp: "2026-10-12T10:00:01.000Z" })).toBe("apply_and_end");
  });
  it("any other newer signal is kept as a signal while the manual status holds", () => {
    expect(decideSignal({ setAt }, { status: "down", timestamp: "2026-10-12T10:05:00.000Z" })).toBe("suppress");
    expect(decideSignal({ setAt }, { status: "idle", timestamp: "2026-10-12T10:05:00.000Z" })).toBe("suppress");
  });
});

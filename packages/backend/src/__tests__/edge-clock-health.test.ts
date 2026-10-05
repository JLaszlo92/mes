import { describe, expect, it } from "vitest";
import { assessEdgeClocks, describeClockOffset, type EdgeClockRow } from "../edge-clock-health.js";

const node = (name: string, clockOffsetMs: number | null, online = true): EdgeClockRow => ({ name, online, clockOffsetMs });

describe("describeClockOffset", () => {
  it("picks a readable unit", () => {
    expect(describeClockOffset(0)).toBe("in sync");
    expect(describeClockOffset(1_999)).toBe("in sync");
    expect(describeClockOffset(45_000)).toBe("45 s ahead");
    expect(describeClockOffset(-45_000)).toBe("45 s behind");
    expect(describeClockOffset(900_000)).toBe("15 min ahead");
    expect(describeClockOffset(-3 * 3_600_000)).toBe("3 h behind");
    expect(describeClockOffset(-1_791_222_000_000)).toBe("20732 days behind");
  });
});

describe("assessEdgeClocks", () => {
  it("is healthy without nodes, with good clocks and with unknown offsets", () => {
    expect(assessEdgeClocks([])).toEqual({ healthy: true });
    expect(assessEdgeClocks([node("a", 0), node("b", -30_000), node("c", 30_000), node("d", null)])).toEqual({ healthy: true });
  });

  it("alerts above the limit in either direction and names the node", () => {
    const ahead = assessEdgeClocks([node("node-gate", 120_000)]);
    expect(ahead.healthy).toBe(false);
    if (!ahead.healthy) {
      expect(ahead.message).toContain("The clock of 1 edge node differs");
      expect(ahead.message).toContain("node-gate (2 min ahead)");
      expect(ahead.message).toContain("more than 30 s");
    }
    const behind = assessEdgeClocks([node("node-gate", -31_000)]);
    expect(behind.healthy).toBe(false);
    if (!behind.healthy) expect(behind.message).toContain("node-gate (31 s behind)");
  });

  it("ignores a node that is offline", () => {
    expect(assessEdgeClocks([node("gone", 900_000, false)])).toEqual({ healthy: true });
  });

  it("lists the worst node first and caps the list", () => {
    const rows = [node("n1", 40_000), node("n2", 900_000), node("n3", -50_000), node("n4", 60_000), node("n5", 70_000), node("n6", 80_000), node("n7", 45_000)];
    const result = assessEdgeClocks(rows);
    expect(result.healthy).toBe(false);
    if (!result.healthy) {
      expect(result.message).toContain("The clock of 7 edge nodes differs");
      expect(result.message.indexOf("n2")).toBeLessThan(result.message.indexOf("n6"));
      expect(result.message).toContain("and 2 more");
      expect(result.message).not.toContain("n1 (");
    }
  });

  it("honours another limit", () => {
    expect(assessEdgeClocks([node("a", 5_000)], 1_000).healthy).toBe(false);
    expect(assessEdgeClocks([node("a", 5_000)], 10_000).healthy).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { mergeBlocks } from "../work-order-assignments-repository.js";

const a = (id: string, workOrderId: string, plannedStart: string, plannedEnd: string) => ({ id, workOrderId, plannedStart, plannedEnd });

describe("mergeBlocks", () => {
  it("shows an order split over several days once, from its first start to its last end", () => {
    const merged = mergeBlocks([
      a("1", "wo1", "2026-10-14T06:00:00Z", "2026-10-14T22:00:00Z"),
      a("2", "wo2", "2026-10-14T08:00:00Z", "2026-10-14T09:00:00Z"),
      a("3", "wo1", "2026-10-15T06:00:00Z", "2026-10-15T22:00:00Z"),
      a("4", "wo1", "2026-10-16T06:00:00Z", "2026-10-16T12:00:00Z"),
    ]);
    expect(merged.map((m) => [m.workOrderId, m.plannedStart, m.plannedEnd, m.blocks])).toEqual([
      ["wo1", "2026-10-14T06:00:00Z", "2026-10-16T12:00:00Z", 3],
      ["wo2", "2026-10-14T08:00:00Z", "2026-10-14T09:00:00Z", 1],
    ]);
  });
  it("leaves single blocks as they are", () => {
    expect(mergeBlocks([a("1", "wo1", "2026-10-14T06:00:00Z", "2026-10-14T07:00:00Z")])).toHaveLength(1);
  });
});

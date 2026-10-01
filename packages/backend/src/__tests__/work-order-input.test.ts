import { describe, expect, it } from "vitest";
import { isCalendarDate, parseWorkOrderBulk, parseWorkOrderCreate, parseWorkOrderPatch } from "../work-order-input.js";

describe("parseWorkOrderPatch", () => {
  it("clears nullable fields with null or empty string", () => {
    expect(parseWorkOrderPatch({ dueDate: "", expectedCycleTimeSeconds: null, notes: "  " })).toEqual({
      ok: true,
      value: { dueDate: null, expectedCycleTimeSeconds: null, notes: null },
    });
  });

  it("validates dates, quantities and statuses", () => {
    expect(parseWorkOrderPatch({ dueDate: "2026-02-30" })).toMatchObject({ ok: false, field: "dueDate" });
    expect(parseWorkOrderPatch({ dueDate: "2026-10-05" })).toEqual({ ok: true, value: { dueDate: "2026-10-05" } });
    expect(parseWorkOrderPatch({ quantity: 0 })).toMatchObject({ ok: false, field: "quantity" });
    expect(parseWorkOrderPatch({ quantity: 2.5 })).toMatchObject({ ok: false, field: "quantity" });
    expect(parseWorkOrderPatch({ status: "done" })).toMatchObject({ ok: false, field: "status" });
  });

  it("rejects order number changes, unknown fields and empty patches", () => {
    expect(parseWorkOrderPatch({ orderNumber: "X" })).toMatchObject({ ok: false, field: "orderNumber" });
    expect(parseWorkOrderPatch({ machineId: "m1" })).toMatchObject({ ok: false, field: "machineId" });
    expect(parseWorkOrderPatch({})).toMatchObject({ ok: false, field: "body" });
  });
});

describe("parseWorkOrderCreate", () => {
  it("requires order number, part and quantity", () => {
    expect(parseWorkOrderCreate({ partName: "A", quantity: 1 })).toMatchObject({ ok: false, field: "orderNumber" });
    expect(parseWorkOrderCreate({ orderNumber: "WO-1", quantity: 1 })).toMatchObject({ ok: false, field: "partName" });
    expect(parseWorkOrderCreate({ orderNumber: "WO-1", partName: "A" })).toMatchObject({ ok: false, field: "quantity" });
    expect(parseWorkOrderCreate({ orderNumber: " WO-1 ", partName: "A", quantity: 5 })).toEqual({
      ok: true,
      value: { orderNumber: "WO-1", partName: "A", quantity: 5 },
    });
  });

  it("only allows planned or released as the initial status", () => {
    expect(parseWorkOrderCreate({ orderNumber: "WO-1", partName: "A", quantity: 5, status: "completed" })).toMatchObject({ ok: false, field: "status" });
  });
});

describe("parseWorkOrderBulk / isCalendarDate", () => {
  it("accepts release and cancel only", () => {
    expect(parseWorkOrderBulk({ action: "release", ids: ["a", "a"] })).toEqual({ ok: true, value: { action: "release", ids: ["a"] } });
    expect(parseWorkOrderBulk({ action: "complete", ids: ["a"] })).toMatchObject({ ok: false, field: "action" });
  });

  it("checks real calendar days", () => {
    expect(isCalendarDate("2028-02-29")).toBe(true);
    expect(isCalendarDate("2027-02-29")).toBe(false);
    expect(isCalendarDate("2026-1-5")).toBe(false);
  });
});

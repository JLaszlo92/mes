import { describe, expect, it } from "vitest";
import { evaluateMeasurement, nextCharacteristic, parsePlanInput, spotDue } from "../quality-input.js";
import { overdueMessage } from "../quality-evaluator.js";

const diameter = { name: "Átmérő", kind: "variable", nominal: 10, lowerLimit: 9.95, upperLimit: 10.05, unit: "mm" };
const visual = { name: "Sorja", kind: "attribute", inFirstPiece: true, inLastPiece: false, inSpot: false };

describe("parsePlanInput", () => {
  it("accepts a plan with all three checks", () => {
    const r = parsePlanInput({
      partName: " Bracket A-12 ",
      firstPiece: { enabled: true, gatesCounting: true },
      lastPiece: { enabled: true, gatesCompletion: false },
      spot: { enabled: true, everyParts: 50, maxMinutes: "60" },
      characteristics: [diameter, visual],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.partName).toBe("Bracket A-12");
    expect(r.value.spot).toEqual({ enabled: true, everyParts: 50, maxMinutes: 60, graceMinutes: 15 });
    expect(r.value.characteristics[1]).toMatchObject({ kind: "attribute", lowerLimit: null, unit: null, inSpot: false });
  });
  it("accepts a decimal comma", () => {
    const r = parsePlanInput({ partName: "P", characteristics: [{ ...diameter, lowerLimit: "9,95" }] });
    expect(r.ok && r.value.characteristics[0]!.lowerLimit).toBe(9.95);
  });
  it("refuses a measured characteristic without limits, reversed limits, a nominal outside", () => {
    expect(parsePlanInput({ partName: "P", characteristics: [{ name: "x", kind: "variable" }] })).toMatchObject({ ok: false, field: "characteristics.0.lowerLimit" });
    expect(parsePlanInput({ partName: "P", characteristics: [{ ...diameter, lowerLimit: 11 }] })).toMatchObject({ ok: false, field: "characteristics.0.upperLimit" });
    expect(parsePlanInput({ partName: "P", characteristics: [{ ...diameter, nominal: 12 }] })).toMatchObject({ ok: false, field: "characteristics.0.nominal" });
  });
  it("refuses an enabled check with no measurement in it, and a spot check without frequency", () => {
    expect(parsePlanInput({ partName: "P", lastPiece: { enabled: true }, characteristics: [visual] })).toMatchObject({ ok: false, field: "lastPiece.enabled" });
    expect(parsePlanInput({ partName: "P", spot: { enabled: true }, characteristics: [diameter] })).toMatchObject({ ok: false, field: "spot.maxMinutes" });
  });
  it("requires the part name", () => {
    expect(parsePlanInput({ partName: "  ", characteristics: [] })).toMatchObject({ ok: false, field: "partName" });
  });
});

describe("evaluateMeasurement", () => {
  const c = { kind: "variable" as const, lowerLimit: 9.95, upperLimit: 10.05 };
  it("passes inside and on the limits", () => {
    expect(evaluateMeasurement(c, { value: 10 })).toBe(true);
    expect(evaluateMeasurement(c, { value: 9.95 })).toBe(true);
    expect(evaluateMeasurement(c, { value: 10.05 })).toBe(true);
  });
  it("fails outside", () => {
    expect(evaluateMeasurement(c, { value: 9.949 })).toBe(false);
    expect(evaluateMeasurement(c, { value: 10.051 })).toBe(false);
    expect(evaluateMeasurement(c, { value: null })).toBe(false);
  });
  it("one-sided limits", () => {
    expect(evaluateMeasurement({ kind: "variable", lowerLimit: null, upperLimit: 1.6 }, { value: 0.2 })).toBe(true);
    expect(evaluateMeasurement({ kind: "variable", lowerLimit: null, upperLimit: 1.6 }, { value: 1.7 })).toBe(false);
  });
  it("attributes", () => {
    expect(evaluateMeasurement({ kind: "attribute", lowerLimit: null, upperLimit: null }, { ok: true })).toBe(true);
    expect(evaluateMeasurement({ kind: "attribute", lowerLimit: null, upperLimit: null }, { ok: false })).toBe(false);
  });
});

describe("nextCharacteristic", () => {
  const chars = [{ id: "a" }, { id: "b" }, { id: "c" }];
  it("is the first not passed, a failed one stays next", () => {
    expect(nextCharacteristic(chars, new Map())?.id).toBe("a");
    expect(nextCharacteristic(chars, new Map([["a", true]]))?.id).toBe("b");
    expect(nextCharacteristic(chars, new Map([["a", true], ["b", false]]))?.id).toBe("b");
    expect(nextCharacteristic(chars, new Map([["a", true], ["b", true], ["c", true]]))).toBeUndefined();
  });
});

describe("spotDue", () => {
  const anchor = new Date("2026-10-12T10:00:00Z");
  const plan = { spotEnabled: true, spotEveryParts: 50, spotMaxMinutes: 60 };
  it("by parts, by time, or not yet", () => {
    expect(spotDue(plan, anchor, 50, new Date("2026-10-12T10:10:00Z"))).toBe("parts");
    expect(spotDue(plan, anchor, 3, new Date("2026-10-12T11:00:00Z"))).toBe("time");
    expect(spotDue(plan, anchor, 49, new Date("2026-10-12T10:59:00Z"))).toBeNull();
    expect(spotDue({ ...plan, spotEnabled: false }, anchor, 500, new Date("2026-10-13T10:00:00Z"))).toBeNull();
  });
});

describe("overdueMessage", () => {
  it("lists the overdue checks, none means no alert", () => {
    expect(overdueMessage([])).toBeNull();
    const m = overdueMessage([{ orderNumber: "WO-1", machineName: "Press 01", machineId: "p1", createdAt: "2026-10-12T10:00:00Z" }], new Date("2026-10-12T10:20:00Z"));
    expect(m).toContain("WO-1 on Press 01 (due for 20 min)");
  });
});

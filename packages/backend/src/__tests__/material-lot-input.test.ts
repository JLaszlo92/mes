import { describe, expect, it } from "vitest";
import { localToday, parseMaterialLotCreate, parseMaterialLotPatch } from "../material-lot-input.js";

const TODAY = "2026-10-12";

describe("parseMaterialLotCreate", () => {
  it("trims and accepts the minimum", () => {
    expect(parseMaterialLotCreate({ materialName: " Acéllemez S235 ", lotNumber: " H-0412 " }, TODAY)).toEqual({
      ok: true,
      value: { materialName: "Acéllemez S235", lotNumber: "H-0412" },
    });
  });
  it("requires material and lot number", () => {
    expect(parseMaterialLotCreate({ lotNumber: "1" }, TODAY)).toMatchObject({ ok: false, field: "materialName" });
    expect(parseMaterialLotCreate({ materialName: "A" }, TODAY)).toMatchObject({ ok: false, field: "lotNumber" });
    expect(parseMaterialLotCreate({ materialName: "A", lotNumber: "  " }, TODAY)).toMatchObject({ ok: false, field: "lotNumber" });
    expect(parseMaterialLotCreate("x", TODAY)).toMatchObject({ ok: false, field: "body" });
  });
  it("empty optional fields become null", () => {
    expect(parseMaterialLotCreate({ materialName: "A", lotNumber: "1", supplier: " ", receivedAt: "" }, TODAY)).toEqual({
      ok: true,
      value: { materialName: "A", lotNumber: "1", supplier: null, receivedAt: null },
    });
  });
  it("checks the date: real, not in the future", () => {
    expect(parseMaterialLotCreate({ materialName: "A", lotNumber: "1", receivedAt: "2026-02-30" }, TODAY)).toMatchObject({ ok: false, field: "receivedAt" });
    expect(parseMaterialLotCreate({ materialName: "A", lotNumber: "1", receivedAt: "2026-10-13" }, TODAY)).toMatchObject({ ok: false, field: "receivedAt" });
    expect(parseMaterialLotCreate({ materialName: "A", lotNumber: "1", receivedAt: TODAY }, TODAY)).toMatchObject({ ok: true });
  });
  it("rejects unknown fields and overlong values", () => {
    expect(parseMaterialLotCreate({ materialName: "A", lotNumber: "1", qty: 5 }, TODAY)).toMatchObject({ ok: false, field: "qty" });
    expect(parseMaterialLotCreate({ materialName: "A", lotNumber: "x".repeat(101) }, TODAY)).toMatchObject({ ok: false, field: "lotNumber" });
  });
});

describe("parseMaterialLotPatch", () => {
  it("changes only what is given; null clears", () => {
    expect(parseMaterialLotPatch({ supplier: null }, TODAY)).toEqual({ ok: true, value: { supplier: null } });
    expect(parseMaterialLotPatch({ lotNumber: "B-2" }, TODAY)).toEqual({ ok: true, value: { lotNumber: "B-2" } });
  });
  it("refuses an empty patch and clearing required fields", () => {
    expect(parseMaterialLotPatch({}, TODAY)).toMatchObject({ ok: false, field: "body" });
    expect(parseMaterialLotPatch({ materialName: "" }, TODAY)).toMatchObject({ ok: false, field: "materialName" });
  });
});

describe("localToday", () => {
  it("formats the local date", () => {
    expect(localToday(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});

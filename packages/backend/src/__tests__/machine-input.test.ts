import { describe, expect, it } from "vitest";
import { parseMachineBulk, parseMachineCreate, parseMachinePatch } from "../machine-input.js";

describe("parseMachinePatch", () => {
  it("keeps only the given fields and trims text", () => {
    expect(parseMachinePatch({ name: "  Press 3 ", isActive: false })).toEqual({ ok: true, value: { name: "Press 3", isActive: false } });
  });

  it("turns empty strings and null into null for clearable fields", () => {
    const r = parseMachinePatch({ assetType: "", idealCycleTimeSeconds: null, lineId: "" });
    expect(r).toEqual({ ok: true, value: { assetType: null, idealCycleTimeSeconds: null, lineId: null } });
  });

  it("rejects clearing a required field", () => {
    expect(parseMachinePatch({ name: "  " })).toMatchObject({ ok: false, field: "name" });
    expect(parseMachinePatch({ areaId: null })).toMatchObject({ ok: false, field: "areaId" });
  });

  it("rejects unknown fields, id changes and empty patches", () => {
    expect(parseMachinePatch({ colour: "red" })).toMatchObject({ ok: false, field: "colour" });
    expect(parseMachinePatch({ id: "x" })).toMatchObject({ ok: false, field: "id" });
    expect(parseMachinePatch({})).toMatchObject({ ok: false, field: "body" });
    expect(parseMachinePatch(null)).toMatchObject({ ok: false, field: "body" });
  });

  it("validates numeric ranges", () => {
    expect(parseMachinePatch({ idealCycleTimeSeconds: 0 })).toMatchObject({ ok: false, field: "idealCycleTimeSeconds" });
    expect(parseMachinePatch({ idealCycleTimeSeconds: "12" })).toMatchObject({ ok: false, field: "idealCycleTimeSeconds" });
    expect(parseMachinePatch({ microStopThresholdSeconds: 3601 })).toMatchObject({ ok: false, field: "microStopThresholdSeconds" });
    expect(parseMachinePatch({ microStopThresholdSeconds: 1.5 })).toMatchObject({ ok: false, field: "microStopThresholdSeconds" });
    expect(parseMachinePatch({ microStopThresholdSeconds: 0 })).toEqual({ ok: true, value: { microStopThresholdSeconds: 0 } });
  });
});

describe("parseMachineCreate", () => {
  it("requires id, name and areaId", () => {
    expect(parseMachineCreate({ name: "A", areaId: "a" })).toMatchObject({ ok: false, field: "id" });
    expect(parseMachineCreate({ id: "m1", areaId: "a" })).toMatchObject({ ok: false, field: "name" });
    expect(parseMachineCreate({ id: "m1", name: "A" })).toMatchObject({ ok: false, field: "areaId" });
    expect(parseMachineCreate({ id: "m1", name: "A", areaId: "a" })).toEqual({ ok: true, value: { id: "m1", name: "A", areaId: "a" } });
  });

  it("restricts machine ids to a safe character set", () => {
    expect(parseMachineCreate({ id: "s7 rig", name: "A", areaId: "a" })).toMatchObject({ ok: false, field: "id" });
    expect(parseMachineCreate({ id: "-x", name: "A", areaId: "a" })).toMatchObject({ ok: false, field: "id" });
    expect(parseMachineCreate({ id: "s7-rig_01.a", name: "A", areaId: "a" })).toMatchObject({ ok: true });
  });
});

describe("parseMachineBulk", () => {
  it("accepts activate/deactivate and deduplicates ids", () => {
    expect(parseMachineBulk({ action: "deactivate", ids: ["a", "b", "a"] })).toEqual({ ok: true, value: { action: "deactivate", ids: ["a", "b"] } });
  });

  it("requires an area for move, line optional", () => {
    expect(parseMachineBulk({ action: "move", ids: ["a"] })).toMatchObject({ ok: false, field: "areaId" });
    expect(parseMachineBulk({ action: "move", ids: ["a"], areaId: "x", lineId: "" })).toEqual({
      ok: true,
      value: { action: "move", ids: ["a"], areaId: "x", lineId: null },
    });
  });

  it("rejects empty id lists and unknown actions", () => {
    expect(parseMachineBulk({ action: "activate", ids: [] })).toMatchObject({ ok: false, field: "ids" });
    expect(parseMachineBulk({ action: "delete", ids: ["a"] })).toMatchObject({ ok: false, field: "action" });
  });
});

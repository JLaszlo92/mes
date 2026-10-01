import { describe, expect, it } from "vitest";
import { parseLabor, parseMaintenanceCreate, parseMaintenancePatch, parsePart } from "../maintenance-input.js";

describe("parseMaintenancePatch", () => {
  it("requires plannedStart and plannedEnd together", () => {
    expect(parseMaintenancePatch({ plannedStart: "2026-10-05T06:00:00Z" })).toMatchObject({ ok: false, field: "plannedEnd" });
    expect(parseMaintenancePatch({ plannedEnd: "2026-10-05T06:00:00Z" })).toMatchObject({ ok: false, field: "plannedStart" });
  });

  it("normalizes a valid window and clears it with nulls", () => {
    expect(parseMaintenancePatch({ plannedStart: "2026-10-05T06:00:00+02:00", plannedEnd: "2026-10-05T08:00:00+02:00" })).toEqual({
      ok: true,
      value: { plannedStart: "2026-10-05T04:00:00.000Z", plannedEnd: "2026-10-05T06:00:00.000Z" },
    });
    expect(parseMaintenancePatch({ plannedStart: null, plannedEnd: "" })).toEqual({ ok: true, value: { plannedStart: null, plannedEnd: null } });
  });

  it("rejects reversed, overlong and malformed windows", () => {
    expect(parseMaintenancePatch({ plannedStart: "2026-10-05T08:00:00Z", plannedEnd: "2026-10-05T06:00:00Z" })).toMatchObject({ ok: false, field: "plannedEnd" });
    expect(parseMaintenancePatch({ plannedStart: "2026-10-01T00:00:00Z", plannedEnd: "2026-10-20T00:00:00Z" })).toMatchObject({ ok: false, field: "plannedEnd" });
    expect(parseMaintenancePatch({ plannedStart: "soon", plannedEnd: "later" })).toMatchObject({ ok: false, field: "plannedStart" });
  });

  it("validates enums and clears the assignee", () => {
    expect(parseMaintenancePatch({ priority: "asap" })).toMatchObject({ ok: false, field: "priority" });
    expect(parseMaintenancePatch({ status: "done" })).toMatchObject({ ok: false, field: "status" });
    expect(parseMaintenancePatch({ assignedTo: "" })).toEqual({ ok: true, value: { assignedTo: null } });
  });
});

describe("parseMaintenanceCreate", () => {
  it("keeps the source of alert/fault-report tickets", () => {
    expect(parseMaintenanceCreate({ machineId: "m1", title: "Investigate", sourceType: "alert", sourceId: "a1" })).toEqual({
      ok: true,
      value: { machineId: "m1", title: "Investigate", sourceType: "alert", sourceId: "a1" },
    });
  });

  it("rejects missing fields and closed starts", () => {
    expect(parseMaintenanceCreate({ title: "x" })).toMatchObject({ ok: false, field: "machineId" });
    expect(parseMaintenanceCreate({ machineId: "m1", title: "x", status: "closed" })).toMatchObject({ ok: false, field: "status" });
  });
});

describe("parts and labor", () => {
  it("defaults quantity to 1 and validates hours", () => {
    expect(parsePart({ partName: " Belt " })).toEqual({ ok: true, value: { partName: "Belt", quantity: 1 } });
    expect(parseLabor({ hours: 0 })).toMatchObject({ ok: false, field: "hours" });
    expect(parseLabor({ hours: 1.5, notes: "" })).toEqual({ ok: true, value: { hours: 1.5, notes: null } });
  });
});

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const repo = {
  createMaterialLot: vi.fn(),
  deleteMaterialLotIfUnused: vi.fn(),
  getMaterialLot: vi.fn(),
  isForeignKeyViolation: (err: unknown) => (err as { code?: string }).code === "23503",
  isUniqueViolation: (err: unknown) => (err as { code?: string }).code === "23505",
  listConsumptionForWorkOrder: vi.fn(),
  listMaterialLotUsage: vi.fn(),
  listMaterialLots: vi.fn(),
  recordConsumption: vi.fn(),
  removeConsumption: vi.fn(),
  updateMaterialLot: vi.fn(),
};
const audit = vi.fn();
vi.mock("../material-lots-repository.js", () => repo);
vi.mock("../lots-repository.js", () => ({ listLots: vi.fn(async () => []), getLotForWorkOrder: vi.fn() }));
vi.mock("../audit-repository.js", () => ({ recordAuditEvent: audit }));
vi.mock("../auth-plugin.js", () => ({ requireRole: () => async () => {} }));

async function app() {
  const { default: routes } = await import("../material-lot-routes.js");
  const a = Fastify();
  a.decorateRequest("user", undefined);
  a.addHook("onRequest", async (request) => {
    (request as unknown as { user: unknown }).user = { id: "u1", role: "admin", email: "a@b" };
  });
  await a.register(routes);
  await a.ready();
  return a;
}

beforeEach(() => {
  for (const fn of Object.values(repo)) if (typeof fn === "function" && "mockReset" in fn) fn.mockReset();
  audit.mockReset();
});

describe("material lots", () => {
  it("creates with validated input and audits it", async () => {
    repo.createMaterialLot.mockResolvedValue({ id: "m1" });
    const r = await (await app()).inject({ method: "POST", url: "/api/material-lots", payload: { materialName: " A ", lotNumber: "1", supplier: "" } });
    expect(r.statusCode).toBe(201);
    expect(repo.createMaterialLot).toHaveBeenCalledWith({ materialName: "A", lotNumber: "1", supplier: null });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "material_lot_created", target: "m1" }));
  });
  it("409 on a duplicate, with the field", async () => {
    repo.createMaterialLot.mockRejectedValue(Object.assign(new Error("dup"), { code: "23505" }));
    const r = await (await app()).inject({ method: "POST", url: "/api/material-lots", payload: { materialName: "A", lotNumber: "1" } });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ field: "lotNumber" });
  });
  it("audits only real changes", async () => {
    const a = await app();
    repo.updateMaterialLot.mockResolvedValueOnce({ current: { id: "m1" }, changes: {} });
    expect((await a.inject({ method: "PATCH", url: "/api/material-lots/m1", payload: { supplier: "X" } })).statusCode).toBe(200);
    expect(audit).not.toHaveBeenCalled();
    repo.updateMaterialLot.mockResolvedValueOnce({ current: { id: "m1" }, changes: { supplier: { from: null, to: "X" } } });
    await a.inject({ method: "PATCH", url: "/api/material-lots/m1", payload: { supplier: "X" } });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "material_lot_updated", details: { changes: { supplier: { from: null, to: "X" } } } }));
    repo.updateMaterialLot.mockResolvedValueOnce(undefined);
    expect((await a.inject({ method: "PATCH", url: "/api/material-lots/x", payload: { supplier: "X" } })).statusCode).toBe(404);
  });
  it("refuses to delete a used lot, deletes an unused one", async () => {
    const a = await app();
    repo.deleteMaterialLotIfUnused.mockResolvedValueOnce({ inUse: 2 });
    const used = await a.inject({ method: "DELETE", url: "/api/material-lots/m1" });
    expect(used.statusCode).toBe(409);
    expect(audit).not.toHaveBeenCalled();
    repo.deleteMaterialLotIfUnused.mockResolvedValueOnce({ deleted: { materialName: "A", lotNumber: "1" } });
    expect((await a.inject({ method: "DELETE", url: "/api/material-lots/m1" })).statusCode).toBe(200);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "material_lot_deleted" }));
    repo.deleteMaterialLotIfUnused.mockResolvedValueOnce("not_found");
    expect((await a.inject({ method: "DELETE", url: "/api/material-lots/x" })).statusCode).toBe(404);
  });
  it("usage: 404 for an unknown lot", async () => {
    repo.getMaterialLot.mockResolvedValue(undefined);
    expect((await (await app()).inject({ method: "GET", url: "/api/material-lots/x/usage" })).statusCode).toBe(404);
    expect(repo.listMaterialLotUsage).not.toHaveBeenCalled();
  });
});

describe("consumption", () => {
  it("records for the signed-in user; unknown ids are 404", async () => {
    const a = await app();
    expect((await a.inject({ method: "POST", url: "/api/work-orders/w1/material-consumption", payload: { materialLotId: "m1" } })).statusCode).toBe(201);
    expect(repo.recordConsumption).toHaveBeenCalledWith("w1", "m1", "u1");
    repo.recordConsumption.mockRejectedValueOnce(Object.assign(new Error("fk"), { code: "23503" }));
    expect((await a.inject({ method: "POST", url: "/api/work-orders/w1/material-consumption", payload: { materialLotId: "zz" } })).statusCode).toBe(404);
    expect((await a.inject({ method: "POST", url: "/api/work-orders/w1/material-consumption", payload: {} })).statusCode).toBe(400);
  });
});

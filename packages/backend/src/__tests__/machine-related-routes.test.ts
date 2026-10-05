import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
vi.mock("../db.js", () => ({ pool: { query } }));
vi.mock("../auth-plugin.js", () => ({ requireRole: () => async () => {} }));

async function app() {
  const { registerMachineRelated } = await import("../machine-related-routes.js");
  const a = Fastify();
  registerMachineRelated(a);
  await a.ready();
  return a;
}

beforeEach(() => {
  query.mockReset();
});

describe("GET /api/machine-registry/:id/related", () => {
  it("404 for an unknown machine, without running the count queries", async () => {
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const r = await (await app()).inject({ method: "GET", url: "/api/machine-registry/ghost/related" });
    expect(r.statusCode).toBe(404);
    expect(query).toHaveBeenCalledTimes(1);
  });
  it("returns the counts and terminals of the machine", async () => {
    query.mockImplementation(async (sql: string, params: unknown[]) => {
      expect(params).toEqual(["m1"]);
      if (sql.includes("SELECT 1 FROM machines")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("terminal_ui_machines")) return { rows: [{ id: "t1", name: "Press terminal" }] };
      return { rows: [{ fc_active: "2", fc_total: "2", ar_active: "1", ar_total: "1", ar_global_active: "0", pm_active: "3", pm_total: "3" }] };
    });
    const r = await (await app()).inject({ method: "GET", url: "/api/machine-registry/m1/related" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      faultCodes: { active: 2, total: 2 },
      alertRules: { active: 1, total: 1, globalActive: 0 },
      preventiveSchedules: { active: 3, total: 3 },
      terminals: [{ id: "t1", name: "Press terminal" }],
    });
  });
});

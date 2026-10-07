import { beforeEach, describe, expect, it, vi } from "vitest";

const { query, raise, resolve } = vi.hoisted(() => ({ query: vi.fn(), raise: vi.fn(), resolve: vi.fn() }));
vi.mock("../db.js", () => ({ pool: { query } }));
vi.mock("../alerts-repository.js", () => ({ raiseOrUpdateSystemAlert: raise, resolveSystemAlert: resolve }));

import { createEdgeCertCheck } from "../edge-cert-health-evaluator.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const row = (days: number) => ({ name: "node-gate-sim", client_cert_expires_at: new Date(NOW + days * DAY) });

describe("createEdgeCertCheck", () => {
  beforeEach(() => {
    query.mockReset();
    raise.mockReset();
    resolve.mockReset();
  });

  it("raises while a certificate is due and resolves once a renewed one is reported", async () => {
    const check = createEdgeCertCheck(log, 30, () => NOW);

    query.mockResolvedValueOnce({ rows: [row(12)], rowCount: 1 });
    raise.mockResolvedValueOnce(true);
    await check();
    expect(raise.mock.calls[0]![0]).toBe("edge_cert_expiry");
    expect(raise.mock.calls[0]![1]).toContain("node-gate-sim (expires in 12 days)");

    query.mockResolvedValueOnce({ rows: [row(11)], rowCount: 1 });
    raise.mockResolvedValueOnce(false);
    await check();
    expect(raise).toHaveBeenCalledTimes(2);
    expect(resolve).not.toHaveBeenCalled();

    query.mockResolvedValueOnce({ rows: [row(365)], rowCount: 1 });
    resolve.mockResolvedValueOnce(true);
    await check();
    expect(resolve).toHaveBeenCalledWith("edge_cert_expiry");
  });

  it("reads every node that reported a certificate, offline ones included, and stays quiet without any", async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    resolve.mockResolvedValueOnce(false);
    await createEdgeCertCheck(log, 30, () => NOW)();
    expect(raise).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledWith("edge_cert_expiry");
    const sql = String(query.mock.calls[0]![0]).split(/\s+/).join(" ");
    expect(sql).toContain("client_cert_expires_at IS NOT NULL");
    expect(sql).not.toContain("last_heartbeat_at");
  });
});

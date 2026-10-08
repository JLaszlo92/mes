import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ pool: { query: vi.fn() } }));

import { databaseHealthy } from "../database-health.js";

describe("databaseHealthy", () => {
  it("is true when the query succeeds", async () => {
    expect(await databaseHealthy(async () => ({ rows: [{ "?column?": 1 }] }))).toBe(true);
  });

  it("is false when the query fails", async () => {
    expect(await databaseHealthy(async () => { throw new Error("ECONNREFUSED"); })).toBe(false);
  });

  it("is false when the query hangs longer than the limit", async () => {
    const started = Date.now();
    expect(await databaseHealthy(() => new Promise(() => undefined), 50)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("does not wait for the limit when the query is fast", async () => {
    const started = Date.now();
    expect(await databaseHealthy(async () => 1, 5000)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

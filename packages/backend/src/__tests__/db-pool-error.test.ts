import { describe, expect, it, vi } from "vitest";
import { pool } from "../db.js";

describe("pool error handling", () => {
  it("has an error listener, so a lost idle connection does not crash the process", () => {
    expect(pool.listenerCount("error")).toBeGreaterThan(0);
  });

  it("survives an error event", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => pool.emit("error", Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" }))).not.toThrow();
    spy.mockRestore();
  });
});

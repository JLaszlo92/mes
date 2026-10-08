import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
vi.mock("../db.js", () => ({ pool: { query: (...args: unknown[]) => query(...args) } }));

import { consumePendingLogin, createPendingLogin } from "../mfa-repository.js";
import { hashPendingToken } from "../pending-token.js";

beforeEach(() => query.mockReset());

describe("pending MFA logins store only the hash of the token", () => {
  it("createPendingLogin returns the raw token and writes its hash", async () => {
    query.mockResolvedValue({ rows: [], rowCount: 1 });
    const { token } = await createPendingLogin("u1");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("token_hash");
    expect(params[0]).toBe(hashPendingToken(token));
    expect(params).not.toContain(token);
    expect(params[1]).toBe("u1");
  });

  it("consumePendingLogin looks the token up by its hash", async () => {
    query.mockResolvedValue({ rows: [{ user_id: "u1" }] });
    await expect(consumePendingLogin("raw-token")).resolves.toEqual({ userId: "u1" });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("token_hash = $1");
    expect(params).toEqual([hashPendingToken("raw-token")]);
  });

  it("consumePendingLogin returns undefined for an unknown or expired token", async () => {
    query.mockResolvedValue({ rows: [] });
    await expect(consumePendingLogin("nope")).resolves.toBeUndefined();
  });
});

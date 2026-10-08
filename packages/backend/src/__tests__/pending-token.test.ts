import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashPendingToken } from "../pending-token.js";

describe("hashPendingToken", () => {
  it("is the SHA-256 hex of the token (same as sessions)", () => {
    expect(hashPendingToken("abc")).toBe(createHash("sha256").update("abc").digest("hex"));
    expect(hashPendingToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("is 64 hex characters and differs from the token", () => {
    const token = "a".repeat(64);
    expect(hashPendingToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPendingToken(token)).not.toBe(token);
  });
});

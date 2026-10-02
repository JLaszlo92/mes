import { describe, expect, it } from "vitest";
import { decideStartMode, legacyFlagFromEnv } from "../start-mode.js";

describe("decideStartMode", () => {
  it("uses registry mode whenever a token is present", () => {
    expect(decideStartMode("tok", false)).toEqual({ mode: "registry", token: "tok" });
  });

  it("the token wins over the legacy flag", () => {
    expect(decideStartMode("tok", true)).toEqual({ mode: "registry", token: "tok" });
  });

  it("starts legacy mode only when asked for explicitly", () => {
    expect(decideStartMode(undefined, true)).toEqual({ mode: "legacy" });
  });

  it("refuses to start without a token and without the legacy flag", () => {
    const d = decideStartMode(undefined, false);
    expect(d.mode).toBe("refuse");
    expect(d).toMatchObject({ reason: expect.stringContaining("EDGE_NODE_TOKEN is not set") });
    expect(d).toMatchObject({ reason: expect.stringContaining("EDGE_AGENT_LEGACY=true") });
  });

  it("treats an empty token as missing", () => {
    expect(decideStartMode("", false).mode).toBe("refuse");
  });
});

describe("legacyFlagFromEnv", () => {
  it("defaults to false", () => {
    expect(legacyFlagFromEnv(undefined)).toBe(false);
    expect(legacyFlagFromEnv("false")).toBe(false);
  });
  it("accepts true in any case", () => {
    expect(legacyFlagFromEnv("true")).toBe(true);
    expect(legacyFlagFromEnv("TRUE")).toBe(true);
  });
  it("rejects typos instead of guessing", () => {
    expect(() => legacyFlagFromEnv("yes")).toThrow(/EDGE_AGENT_LEGACY/);
    expect(() => legacyFlagFromEnv("1")).toThrow(/EDGE_AGENT_LEGACY/);
  });
});

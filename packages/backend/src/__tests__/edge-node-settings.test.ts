import { describe, expect, it } from "vitest";
import { resolveSettings, validateSettingsPatch } from "../edge-node-settings.js";

describe("resolveSettings", () => {
  it("defaults", () => {
    expect(resolveSettings({})).toEqual({ catchupMaxMinutes: 10 });
    expect(resolveSettings(null)).toEqual({ catchupMaxMinutes: 10 });
    expect(resolveSettings([1])).toEqual({ catchupMaxMinutes: 10 });
  });
  it("keeps valid values, repairs garbage", () => {
    expect(resolveSettings({ catchupMaxMinutes: 0 })).toEqual({ catchupMaxMinutes: 0 });
    expect(resolveSettings({ catchupMaxMinutes: 30 })).toEqual({ catchupMaxMinutes: 30 });
    expect(resolveSettings({ catchupMaxMinutes: -1 })).toEqual({ catchupMaxMinutes: 10 });
    expect(resolveSettings({ catchupMaxMinutes: "5" })).toEqual({ catchupMaxMinutes: 10 });
    expect(resolveSettings({ catchupMaxMinutes: 1.5 })).toEqual({ catchupMaxMinutes: 10 });
    expect(resolveSettings({ catchupMaxMinutes: 1441 })).toEqual({ catchupMaxMinutes: 10 });
  });
});

describe("validateSettingsPatch", () => {
  it("accepts a valid patch", () => {
    expect(validateSettingsPatch({ catchupMaxMinutes: 15 })).toEqual({ ok: true, patch: { catchupMaxMinutes: 15 } });
    expect(validateSettingsPatch({ catchupMaxMinutes: 0 })).toEqual({ ok: true, patch: { catchupMaxMinutes: 0 } });
    expect(validateSettingsPatch({ catchupMaxMinutes: 1440 }).ok).toBe(true);
  });
  it("rejects bad input", () => {
    for (const body of [null, [], "x", {}, { catchupMaxMinutes: -1 }, { catchupMaxMinutes: 1441 }, { catchupMaxMinutes: "5" }, { catchupMaxMinutes: 2.5 }, { foo: 1 }, { catchupMaxMinutes: 5, foo: 1 }]) {
      expect(validateSettingsPatch(body).ok).toBe(false);
    }
  });
});

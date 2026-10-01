import { describe, expect, it } from "vitest";
import { likePattern, parseIdList, parseInstant, parsePaging } from "../paging.js";

describe("paging params", () => {
  it("defaults and bounds limit/offset", () => {
    expect(parsePaging({})).toEqual({ ok: true, value: { limit: 50, offset: 0 } });
    expect(parsePaging({ limit: "201" })).toMatchObject({ ok: false, field: "limit" });
    expect(parsePaging({ limit: "abc" })).toMatchObject({ ok: false, field: "limit" });
    expect(parsePaging({ offset: "-1" })).toMatchObject({ ok: false, field: "offset" });
    expect(parsePaging({ limit: "25", offset: "50" })).toEqual({ ok: true, value: { limit: 25, offset: 50 } });
  });

  it("parses id lists and instants", () => {
    expect(parseIdList("machineIds", "a, b,,a")).toEqual({ ok: true, value: ["a", "b"] });
    expect(parseIdList("machineIds", "")).toEqual({ ok: true, value: undefined });
    expect(parseInstant("from", "nope")).toMatchObject({ ok: false, field: "from" });
  });

  it("escapes LIKE wildcards", () => {
    expect(likePattern("50%_off\\")).toBe("%50\\%\\_off\\\\%");
  });
});

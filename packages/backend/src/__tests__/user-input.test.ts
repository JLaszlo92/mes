import { describe, expect, it } from "vitest";
import { parseRoleWrite, parseUserCreate, parseUserPatch } from "../user-input.js";

describe("parseUserCreate", () => {
  it("accepts a terminal-only worker", () => {
    expect(parseUserCreate({ displayName: " Kovács János ", employeeNumber: "1042", role: "operator" })).toEqual({
      ok: true,
      value: { displayName: "Kovács János", employeeNumber: "1042", role: "operator" },
    });
  });
  it("needs a name or number, a role, and e-mail with password together", () => {
    expect(parseUserCreate({ role: "operator" })).toMatchObject({ ok: false, field: "displayName" });
    expect(parseUserCreate({ displayName: "A" })).toMatchObject({ ok: false, field: "role" });
    expect(parseUserCreate({ displayName: "A", role: "admin", email: "a@b.hu" })).toMatchObject({ ok: false, field: "password" });
    expect(parseUserCreate({ displayName: "A", role: "admin", password: "long-enough-1" })).toMatchObject({ ok: false, field: "email" });
    expect(parseUserCreate({ displayName: "A", role: "admin", email: "A@B.hu", password: "long-enough-1" })).toMatchObject({ ok: true, value: { email: "a@b.hu" } });
  });
  it("checks e-mail and password", () => {
    expect(parseUserCreate({ displayName: "A", role: "x", email: "nope", password: "long-enough-1" })).toMatchObject({ ok: false, field: "email" });
    expect(parseUserCreate({ displayName: "A", role: "x", email: "a@b.hu", password: "short" })).toMatchObject({ ok: false, field: "password" });
  });
});

describe("parseUserPatch", () => {
  it("null or empty clears; unknown fields are refused", () => {
    expect(parseUserPatch({ email: "", password: null })).toEqual({ ok: true, value: { email: null, password: null } });
    expect(parseUserPatch({ pin: "12345" })).toMatchObject({ ok: false, field: "pin" });
    expect(parseUserPatch({})).toMatchObject({ ok: false, field: "body" });
  });
});

describe("parseRoleWrite", () => {
  it("validates names and permissions", () => {
    expect(parseRoleWrite({ name: "Műszakvezető", permissions: ["alerts.acknowledge", "alerts.acknowledge"] }, true)).toEqual({
      ok: true,
      value: { name: "Műszakvezető", permissions: ["alerts.acknowledge"] },
    });
    expect(parseRoleWrite({ permissions: ["root"] }, false)).toMatchObject({ ok: false, field: "permissions" });
    expect(parseRoleWrite({}, true)).toMatchObject({ ok: false, field: "name" });
  });
});

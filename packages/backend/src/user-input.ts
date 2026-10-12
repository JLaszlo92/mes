/**
 * Felhasználó- és szerep-bemenetek validálása — tiszta függvények
 * (__tests__/user-input.test.ts).
 */
import type { ValidationResult } from "./machine-input.js";
import { isPermission, type Permission } from "./permissions.js";
import type { UserWrite } from "./users-repository.js";

class FieldError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function optionalText(field: string, v: unknown, max: number): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new FieldError(field, `${field} must be text`);
  const t = v.trim();
  if (t === "") return null;
  if (t.length > max) throw new FieldError(field, `${field} must be at most ${max} characters`);
  return t;
}

const USER_FIELDS = ["displayName", "employeeNumber", "email", "password", "role", "isActive"];
export const MIN_PASSWORD_LENGTH = 10;

function parseUserFields(body: Record<string, unknown>): UserWrite {
  for (const key of Object.keys(body)) {
    if (!USER_FIELDS.includes(key)) throw new FieldError(key, `unknown field "${key}"`);
  }
  const u: UserWrite = {};
  if ("displayName" in body) u.displayName = optionalText("displayName", body.displayName, 120);
  if ("employeeNumber" in body) u.employeeNumber = optionalText("employeeNumber", body.employeeNumber, 40);
  if ("email" in body) {
    const e = optionalText("email", body.email, 254);
    if (e !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new FieldError("email", "enter a valid e-mail address");
    u.email = e === null ? null : e.toLowerCase();
  }
  if ("password" in body) {
    const p = body.password;
    if (p === null || p === "") u.password = null;
    else if (typeof p !== "string") throw new FieldError("password", "password must be text");
    else if (p.length < MIN_PASSWORD_LENGTH) throw new FieldError("password", `the password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    else if (p.length > 200) throw new FieldError("password", "the password is too long");
    else u.password = p;
  }
  if ("role" in body) {
    if (typeof body.role !== "string" || body.role === "") throw new FieldError("role", "choose a role");
    u.role = body.role;
  }
  if ("isActive" in body) {
    if (typeof body.isActive !== "boolean") throw new FieldError("isActive", "isActive must be true or false");
    u.isActive = body.isActive;
  }
  return u;
}

function wrap<T>(fn: () => T): ValidationResult<T> {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    if (err instanceof FieldError) return { ok: false, field: err.field, error: err.message };
    throw err;
  }
}

/** A new user needs a name or an employee number, and a role; e-mail and password come together or not at all. */
export function parseUserCreate(body: unknown): ValidationResult<UserWrite & { role: string }> {
  return wrap(() => {
    if (!isRecord(body)) throw new FieldError("body", "request body must be a JSON object");
    const u = parseUserFields(body);
    if (!u.role) throw new FieldError("role", "choose a role");
    if (!u.displayName && !u.employeeNumber) throw new FieldError("displayName", "enter a name");
    if (!!u.email !== !!u.password) {
      throw new FieldError(u.email ? "password" : "email", "dashboard sign-in needs both an e-mail and a password (leave both empty for a terminal-only worker)");
    }
    return { ...u, role: u.role };
  });
}

export function parseUserPatch(body: unknown): ValidationResult<UserWrite> {
  return wrap(() => {
    if (!isRecord(body)) throw new FieldError("body", "request body must be a JSON object");
    const u = parseUserFields(body);
    if (Object.keys(u).length === 0) throw new FieldError("body", "no fields to update");
    return u;
  });
}

export interface RolePatch {
  name?: string;
  description?: string | null;
  permissions?: Permission[];
}

export function parseRoleWrite(body: unknown, creating: boolean): ValidationResult<RolePatch> {
  return wrap(() => {
    if (!isRecord(body)) throw new FieldError("body", "request body must be a JSON object");
    for (const key of Object.keys(body)) {
      if (!["name", "description", "permissions"].includes(key)) throw new FieldError(key, `unknown field "${key}"`);
    }
    const r: RolePatch = {};
    if ("name" in body || creating) {
      const n = optionalText("name", body.name, 60);
      if (!n) throw new FieldError("name", "enter a name for the role");
      r.name = n;
    }
    if ("description" in body) r.description = optionalText("description", body.description, 200);
    if ("permissions" in body) {
      const p = body.permissions;
      if (!Array.isArray(p)) throw new FieldError("permissions", "permissions must be a list");
      const bad = p.find((x) => !isPermission(x));
      if (bad !== undefined) throw new FieldError("permissions", `unknown permission "${String(bad)}"`);
      r.permissions = [...new Set(p as Permission[])];
    }
    if (!creating && Object.keys(r).length === 0) throw new FieldError("body", "no fields to update");
    return r;
  });
}

/**
 * Alapanyag-tétel bemenetek validálása — tiszta függvények
 * (__tests__/material-lot-input.test.ts). Hiányzó kulcs = nem változik,
 * null/"" = törlés a nullázható mezőknél, hibánál { field, error }.
 */
import type { ValidationResult } from "./machine-input.js";
import { isCalendarDate } from "./work-order-input.js";

export interface MaterialLotPatch {
  materialName?: string;
  lotNumber?: string;
  supplier?: string | null;
  receivedAt?: string | null;
}

export interface MaterialLotCreate extends MaterialLotPatch {
  materialName: string;
  lotNumber: string;
}

const FIELDS = ["materialName", "lotNumber", "supplier", "receivedAt"] as const;

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

function text(field: string, v: unknown, max: number): string {
  if (typeof v !== "string" || v.trim() === "") throw new FieldError(field, `${field} must be a non-empty string`);
  const t = v.trim();
  if (t.length > max) throw new FieldError(field, `${field} must be at most ${max} characters`);
  return t;
}

function parseFields(body: Record<string, unknown>, today: string): MaterialLotPatch {
  for (const key of Object.keys(body)) {
    if (!(FIELDS as readonly string[]).includes(key)) throw new FieldError(key, `unknown field "${key}"`);
  }
  const p: MaterialLotPatch = {};
  if ("materialName" in body) p.materialName = text("materialName", body.materialName, 200);
  if ("lotNumber" in body) p.lotNumber = text("lotNumber", body.lotNumber, 100);
  if ("supplier" in body) {
    const v = body.supplier;
    if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) p.supplier = null;
    else p.supplier = text("supplier", v, 200);
  }
  if ("receivedAt" in body) {
    const v = body.receivedAt;
    if (v === null || v === undefined || v === "") p.receivedAt = null;
    else if (typeof v !== "string" || !isCalendarDate(v)) throw new FieldError("receivedAt", "receivedAt must be a date (YYYY-MM-DD) or empty");
    // A delivery cannot arrive in the future; a typo in the year is the usual cause.
    else if (v > today) throw new FieldError("receivedAt", "receivedAt cannot be in the future");
    else p.receivedAt = v;
  }
  return p;
}

function wrap<T>(fn: () => T): ValidationResult<T> {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    if (err instanceof FieldError) return { ok: false, field: err.field, error: err.message };
    throw err;
  }
}

/** `today` is the plant's local date (YYYY-MM-DD); a parameter so the tests do not depend on the clock. */
export function parseMaterialLotCreate(body: unknown, today: string): ValidationResult<MaterialLotCreate> {
  return wrap(() => {
    if (!isRecord(body)) throw new FieldError("body", "request body must be a JSON object");
    if (!("materialName" in body)) throw new FieldError("materialName", "materialName is required");
    if (!("lotNumber" in body)) throw new FieldError("lotNumber", "lotNumber is required");
    const p = parseFields(body, today);
    return { ...p, materialName: p.materialName!, lotNumber: p.lotNumber! };
  });
}

export function parseMaterialLotPatch(body: unknown, today: string): ValidationResult<MaterialLotPatch> {
  return wrap(() => {
    if (!isRecord(body)) throw new FieldError("body", "request body must be a JSON object");
    const p = parseFields(body, today);
    if (Object.keys(p).length === 0) throw new FieldError("body", "no fields to update");
    return p;
  });
}

/** The local calendar day (the process runs in MES_TIMEZONE, see config.ts). */
export function localToday(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

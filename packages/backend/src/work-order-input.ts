/**
 * Gyártási munkarendelés bemenetek validálása — tiszta függvények
 * (__tests__/work-order-input.test.ts). Ugyanaz a szemantika, mint a
 * machine-input.ts-ben: hiányzó kulcs = nem változik, null/"" = törlés a
 * nullázható mezőknél, hibánál { field, error }.
 */
import type { ValidationResult } from "./machine-input.js";

export const WORK_ORDER_STATUSES = ["planned", "released", "in_progress", "completed", "cancelled"] as const;
export type WorkOrderStatusValue = (typeof WORK_ORDER_STATUSES)[number];

export interface WorkOrderPatch {
  partName?: string;
  quantity?: number;
  expectedCycleTimeSeconds?: number | null;
  dueDate?: string | null;
  status?: WorkOrderStatusValue;
  notes?: string | null;
  completionMode?: "manual" | "auto";
  countOverproduction?: boolean;
}

export interface WorkOrderCreate extends WorkOrderPatch {
  orderNumber: string;
  partName: string;
  quantity: number;
}

class FieldError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

const FIELDS = [
  "partName",
  "quantity",
  "expectedCycleTimeSeconds",
  "dueDate",
  "status",
  "notes",
  "completionMode",
  "countOverproduction",
] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function text(field: string, v: unknown, max: number): string {
  if (typeof v !== "string" || v.trim() === "") throw new FieldError(field, `${field} must be a non-empty string`);
  const t = v.trim();
  if (t.length > max) throw new FieldError(field, `${field} must be at most ${max} characters`);
  return t;
}

/** Valódi naptári nap-e (pl. 2026-02-30 nem az). */
export function isCalendarDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function parseFields(body: Record<string, unknown>): WorkOrderPatch {
  const p: WorkOrderPatch = {};
  if ("partName" in body) p.partName = text("partName", body.partName, 200);
  if ("quantity" in body) {
    const q = body.quantity;
    if (typeof q !== "number" || !Number.isInteger(q) || q < 1 || q > 10_000_000) {
      throw new FieldError("quantity", "quantity must be a whole number between 1 and 10,000,000");
    }
    p.quantity = q;
  }
  if ("expectedCycleTimeSeconds" in body) {
    const v = body.expectedCycleTimeSeconds;
    if (v === null || v === "") p.expectedCycleTimeSeconds = null;
    else if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 86_400) {
      throw new FieldError("expectedCycleTimeSeconds", "expectedCycleTimeSeconds must be a positive number of at most 86400, or null");
    } else p.expectedCycleTimeSeconds = v;
  }
  if ("dueDate" in body) {
    const v = body.dueDate;
    if (v === null || v === "") p.dueDate = null;
    else if (typeof v !== "string" || !isCalendarDate(v)) throw new FieldError("dueDate", "dueDate must be a date (YYYY-MM-DD) or null");
    else p.dueDate = v;
  }
  if ("status" in body) {
    if (!(WORK_ORDER_STATUSES as readonly unknown[]).includes(body.status)) {
      throw new FieldError("status", `status must be one of: ${WORK_ORDER_STATUSES.join(", ")}`);
    }
    p.status = body.status as WorkOrderStatusValue;
  }
  if ("notes" in body) {
    const v = body.notes;
    if (v === null) p.notes = null;
    else if (typeof v !== "string") throw new FieldError("notes", "notes must be a string or null");
    else if (v.length > 2000) throw new FieldError("notes", "notes must be at most 2000 characters");
    else p.notes = v.trim() === "" ? null : v;
  }
  if ("completionMode" in body) {
    if (body.completionMode !== "manual" && body.completionMode !== "auto") {
      throw new FieldError("completionMode", 'completionMode must be "manual" or "auto"');
    }
    p.completionMode = body.completionMode;
  }
  if ("countOverproduction" in body) {
    if (typeof body.countOverproduction !== "boolean") throw new FieldError("countOverproduction", "countOverproduction must be true or false");
    p.countOverproduction = body.countOverproduction;
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

export function parseWorkOrderPatch(body: unknown): ValidationResult<WorkOrderPatch> {
  return wrap(() => {
    if (!isRecord(body)) throw new FieldError("body", "request body must be a JSON object");
    if ("orderNumber" in body) throw new FieldError("orderNumber", "the order number cannot be changed");
    for (const key of Object.keys(body)) {
      if (!(FIELDS as readonly string[]).includes(key)) throw new FieldError(key, `unknown field "${key}"`);
    }
    const patch = parseFields(body);
    if (Object.keys(patch).length === 0) throw new FieldError("body", "no fields to update");
    return patch;
  });
}

export function parseWorkOrderCreate(body: unknown): ValidationResult<WorkOrderCreate> {
  return wrap(() => {
    if (!isRecord(body)) throw new FieldError("body", "request body must be a JSON object");
    for (const key of Object.keys(body)) {
      if (key !== "orderNumber" && !(FIELDS as readonly string[]).includes(key)) throw new FieldError(key, `unknown field "${key}"`);
    }
    const orderNumber = text("orderNumber", body.orderNumber, 64);
    if (!("partName" in body)) throw new FieldError("partName", "partName is required");
    if (!("quantity" in body)) throw new FieldError("quantity", "quantity is required");
    const fields = parseFields(body);
    if (fields.status !== undefined && fields.status !== "planned" && fields.status !== "released") {
      throw new FieldError("status", "a new work order starts as planned or released");
    }
    return { ...fields, orderNumber, partName: fields.partName!, quantity: fields.quantity! };
  });
}

/** Tömeges státuszváltás: csak a biztonságos, tervezési oldali átmenetek. */
export type WorkOrderBulk = { action: "release" | "cancel"; ids: string[] };

export function parseWorkOrderBulk(body: unknown): ValidationResult<WorkOrderBulk> {
  return wrap(() => {
    if (!isRecord(body)) throw new FieldError("body", "request body must be a JSON object");
    const ids = body.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500 || !ids.every((x) => typeof x === "string" && x !== "")) {
      throw new FieldError("ids", "ids must be a non-empty array of at most 500 work order ids");
    }
    if (body.action !== "release" && body.action !== "cancel") throw new FieldError("action", 'action must be "release" or "cancel"');
    return { action: body.action, ids: [...new Set(ids as string[])] };
  });
}

/** Melyik státuszból mehet tömegesen az adott művelet. */
export const BULK_ELIGIBLE: Record<WorkOrderBulk["action"], { from: WorkOrderStatusValue[]; to: WorkOrderStatusValue }> = {
  release: { from: ["planned"], to: "released" },
  cancel: { from: ["planned", "released"], to: "cancelled" },
};

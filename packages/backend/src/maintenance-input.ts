/**
 * Karbantartási munkarendelés bemenetek validálása — tiszta függvények
 * (__tests__/maintenance-input.test.ts), ugyanazzal a PATCH-szemantikával,
 * mint a gép- és gyártási rendeléseknél.
 */
import type { ValidationResult } from "./machine-input.js";

export const MAINTENANCE_STATUSES = ["open", "assigned", "in_progress", "closed"] as const;
export const MAINTENANCE_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const MAINTENANCE_SOURCES = ["alert", "fault_report", "preventive_schedule", "manual"] as const;

export type MaintenanceStatusValue = (typeof MAINTENANCE_STATUSES)[number];
export type MaintenancePriority = (typeof MAINTENANCE_PRIORITIES)[number];

/** Egy karbantartási ablak legfeljebb ennyi lehet — elírás (rossz év) ellen. */
export const MAX_MAINTENANCE_WINDOW_MS = 14 * 24 * 3600 * 1000;

export interface MaintenancePatch {
  machineId?: string;
  title?: string;
  description?: string | null;
  status?: MaintenanceStatusValue;
  priority?: MaintenancePriority;
  assignedTo?: string | null;
  /** Mindkettő együtt változik (vagy mindkettő null = terv törlése). */
  plannedStart?: string | null;
  plannedEnd?: string | null;
}

export interface MaintenanceCreate extends MaintenancePatch {
  machineId: string;
  title: string;
  sourceType?: (typeof MAINTENANCE_SOURCES)[number];
  sourceId?: string;
}

class FieldError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

const FIELDS = ["machineId", "title", "description", "status", "priority", "assignedTo", "plannedStart", "plannedEnd"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function oneOf<T extends string>(field: string, v: unknown, values: readonly T[]): T {
  if (!(values as readonly unknown[]).includes(v)) throw new FieldError(field, `${field} must be one of: ${values.join(", ")}`);
  return v as T;
}

function parseInstant(field: string, v: unknown): string {
  if (typeof v !== "string" || isNaN(new Date(v).getTime())) throw new FieldError(field, `${field} must be an ISO date-time`);
  return new Date(v).toISOString();
}

function parseFields(body: Record<string, unknown>): MaintenancePatch {
  const p: MaintenancePatch = {};
  if ("machineId" in body) {
    if (typeof body.machineId !== "string" || body.machineId.trim() === "") throw new FieldError("machineId", "machineId is required");
    p.machineId = body.machineId.trim();
  }
  if ("title" in body) {
    if (typeof body.title !== "string" || body.title.trim() === "") throw new FieldError("title", "title must be a non-empty string");
    if (body.title.trim().length > 200) throw new FieldError("title", "title must be at most 200 characters");
    p.title = body.title.trim();
  }
  if ("description" in body) {
    const v = body.description;
    if (v === null) p.description = null;
    else if (typeof v !== "string") throw new FieldError("description", "description must be a string or null");
    else if (v.length > 4000) throw new FieldError("description", "description must be at most 4000 characters");
    else p.description = v.trim() === "" ? null : v;
  }
  if ("status" in body) p.status = oneOf("status", body.status, MAINTENANCE_STATUSES);
  if ("priority" in body) p.priority = oneOf("priority", body.priority, MAINTENANCE_PRIORITIES);
  if ("assignedTo" in body) {
    const v = body.assignedTo;
    if (v === null || v === "") p.assignedTo = null;
    else if (typeof v !== "string") throw new FieldError("assignedTo", "assignedTo must be a user id or null");
    else p.assignedTo = v;
  }
  const hasStart = "plannedStart" in body;
  const hasEnd = "plannedEnd" in body;
  if (hasStart !== hasEnd) throw new FieldError(hasStart ? "plannedEnd" : "plannedStart", "plannedStart and plannedEnd must be set together");
  if (hasStart) {
    const s = body.plannedStart;
    const e = body.plannedEnd;
    if ((s === null || s === "") && (e === null || e === "")) {
      p.plannedStart = null;
      p.plannedEnd = null;
    } else {
      const start = parseInstant("plannedStart", s);
      const end = parseInstant("plannedEnd", e);
      const ms = new Date(end).getTime() - new Date(start).getTime();
      if (ms <= 0) throw new FieldError("plannedEnd", "plannedEnd must be after plannedStart");
      if (ms > MAX_MAINTENANCE_WINDOW_MS) throw new FieldError("plannedEnd", "a maintenance window can be at most 14 days long");
      p.plannedStart = start;
      p.plannedEnd = end;
    }
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

export function parseMaintenancePatch(body: unknown): ValidationResult<MaintenancePatch> {
  return wrap(() => {
    if (!isRecord(body)) throw new FieldError("body", "request body must be a JSON object");
    for (const key of Object.keys(body)) {
      if (!(FIELDS as readonly string[]).includes(key)) throw new FieldError(key, `unknown field "${key}"`);
    }
    const patch = parseFields(body);
    if (Object.keys(patch).length === 0) throw new FieldError("body", "no fields to update");
    return patch;
  });
}

export function parseMaintenanceCreate(body: unknown): ValidationResult<MaintenanceCreate> {
  return wrap(() => {
    if (!isRecord(body)) throw new FieldError("body", "request body must be a JSON object");
    for (const key of Object.keys(body)) {
      if (key !== "sourceType" && key !== "sourceId" && !(FIELDS as readonly string[]).includes(key)) {
        throw new FieldError(key, `unknown field "${key}"`);
      }
    }
    if (!("machineId" in body)) throw new FieldError("machineId", "machineId is required");
    if (!("title" in body)) throw new FieldError("title", "title is required");
    const fields = parseFields(body);
    if (fields.status === "closed") throw new FieldError("status", "a new work order cannot start closed");
    const create: MaintenanceCreate = { ...fields, machineId: fields.machineId!, title: fields.title! };
    if ("sourceType" in body && body.sourceType !== undefined) create.sourceType = oneOf("sourceType", body.sourceType, MAINTENANCE_SOURCES);
    if ("sourceId" in body && body.sourceId !== undefined) {
      if (typeof body.sourceId !== "string") throw new FieldError("sourceId", "sourceId must be a string");
      create.sourceId = body.sourceId;
    }
    return create;
  });
}

export function parsePart(body: unknown): ValidationResult<{ partName: string; quantity: number }> {
  return wrap(() => {
    if (!isRecord(body) || typeof body.partName !== "string" || body.partName.trim() === "") throw new FieldError("partName", "partName is required");
    const q = body.quantity ?? 1;
    if (typeof q !== "number" || !Number.isInteger(q) || q < 1 || q > 100_000) throw new FieldError("quantity", "quantity must be a whole number of at least 1");
    return { partName: body.partName.trim().slice(0, 200), quantity: q };
  });
}

export function parseLabor(body: unknown): ValidationResult<{ hours: number; notes: string | null }> {
  return wrap(() => {
    if (!isRecord(body)) throw new FieldError("body", "request body must be a JSON object");
    const h = body.hours;
    if (typeof h !== "number" || !Number.isFinite(h) || h <= 0 || h > 1000) throw new FieldError("hours", "hours must be a positive number of at most 1000");
    const notes = typeof body.notes === "string" && body.notes.trim() !== "" ? body.notes.trim().slice(0, 1000) : null;
    return { hours: h, notes };
  });
}

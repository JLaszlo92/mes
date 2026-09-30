/**
 * A gép-törzsadat bemenetek validálása — tiszta függvények, unit-tesztelve
 * (__tests__/machine-input.test.ts). A route-ok csak ezen keresztül adnak
 * tovább adatot a repositorynak, így egy rossz bemenet 400-at ad (mezőnévvel),
 * nem 500-at.
 *
 * PATCH-szemantika: a hiányzó kulcs = "nem változik"; a null = "törlés"
 * (csak a nullázható mezőknél). Ez a régi COALESCE-es UPDATE-tel nem volt
 * lehetséges — egy egyszer kitöltött típust vagy ciklusidőt nem lehetett
 * kiüríteni.
 */

export interface MachinePatch {
  name?: string;
  assetType?: string | null;
  location?: string | null;
  idealCycleTimeSeconds?: number | null;
  isActive?: boolean;
  areaId?: string;
  lineId?: string | null;
  shiftPatternId?: string;
  calendarId?: string;
  autoOffshiftStatus?: boolean;
  microStopThresholdSeconds?: number;
}

export interface MachineCreate extends MachinePatch {
  id: string;
  name: string;
  areaId: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; field: string; error: string };

const MAX_TEXT = 100;
const MACHINE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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

function requiredText(field: string, v: unknown): string {
  if (typeof v !== "string" || v.trim() === "") throw new FieldError(field, `${field} must be a non-empty string`);
  const t = v.trim();
  if (t.length > MAX_TEXT) throw new FieldError(field, `${field} must be at most ${MAX_TEXT} characters`);
  return t;
}

/** Üres string → null, így egy kiürített űrlapmező törli az értéket. */
function optionalText(field: string, v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== "string") throw new FieldError(field, `${field} must be a string or null`);
  const t = v.trim();
  if (t === "") return null;
  if (t.length > MAX_TEXT) throw new FieldError(field, `${field} must be at most ${MAX_TEXT} characters`);
  return t;
}

function id(field: string, v: unknown): string {
  if (typeof v !== "string" || v.trim() === "") throw new FieldError(field, `${field} must be a non-empty id`);
  return v.trim();
}

function bool(field: string, v: unknown): boolean {
  if (typeof v !== "boolean") throw new FieldError(field, `${field} must be true or false`);
  return v;
}

const PATCH_FIELDS = [
  "name",
  "assetType",
  "location",
  "idealCycleTimeSeconds",
  "isActive",
  "areaId",
  "lineId",
  "shiftPatternId",
  "calendarId",
  "autoOffshiftStatus",
  "microStopThresholdSeconds",
] as const;

function parsePatchFields(body: Record<string, unknown>): MachinePatch {
  const patch: MachinePatch = {};
  for (const key of Object.keys(body)) {
    if (key === "id") continue; // create-nél külön kezeljük; patch-nél lent tiltjuk
    if (!(PATCH_FIELDS as readonly string[]).includes(key)) throw new FieldError(key, `unknown field "${key}"`);
  }
  if ("name" in body) patch.name = requiredText("name", body.name);
  if ("assetType" in body) patch.assetType = optionalText("assetType", body.assetType);
  if ("location" in body) patch.location = optionalText("location", body.location);
  if ("idealCycleTimeSeconds" in body) {
    const v = body.idealCycleTimeSeconds;
    if (v === null || v === "") patch.idealCycleTimeSeconds = null;
    else if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 86_400) {
      throw new FieldError("idealCycleTimeSeconds", "idealCycleTimeSeconds must be a positive number of at most 86400, or null");
    } else patch.idealCycleTimeSeconds = v;
  }
  if ("isActive" in body) patch.isActive = bool("isActive", body.isActive);
  if ("areaId" in body) patch.areaId = id("areaId", body.areaId);
  if ("lineId" in body) patch.lineId = body.lineId === null || body.lineId === "" ? null : id("lineId", body.lineId);
  if ("shiftPatternId" in body) patch.shiftPatternId = id("shiftPatternId", body.shiftPatternId);
  if ("calendarId" in body) patch.calendarId = id("calendarId", body.calendarId);
  if ("autoOffshiftStatus" in body) patch.autoOffshiftStatus = bool("autoOffshiftStatus", body.autoOffshiftStatus);
  if ("microStopThresholdSeconds" in body) {
    const v = body.microStopThresholdSeconds;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 3600) {
      throw new FieldError("microStopThresholdSeconds", "microStopThresholdSeconds must be an integer between 0 and 3600");
    }
    patch.microStopThresholdSeconds = v;
  }
  return patch;
}

function wrap<T>(fn: () => T): ValidationResult<T> {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    if (err instanceof FieldError) return { ok: false, field: err.field, error: err.message };
    throw err;
  }
}

export function parseMachinePatch(body: unknown): ValidationResult<MachinePatch> {
  return wrap(() => {
    if (!isRecord(body)) throw new FieldError("body", "request body must be a JSON object");
    if ("id" in body) throw new FieldError("id", "a machine id cannot be changed");
    const patch = parsePatchFields(body);
    if (Object.keys(patch).length === 0) throw new FieldError("body", "no fields to update");
    return patch;
  });
}

export function parseMachineCreate(body: unknown): ValidationResult<MachineCreate> {
  return wrap(() => {
    if (!isRecord(body)) throw new FieldError("body", "request body must be a JSON object");
    const machineId = typeof body.id === "string" ? body.id.trim() : "";
    if (!MACHINE_ID_RE.test(machineId)) {
      throw new FieldError("id", "id must be 1–64 characters: letters, digits, '.', '_' or '-', starting with a letter or digit");
    }
    if (!("name" in body)) throw new FieldError("name", "name is required");
    if (!("areaId" in body)) throw new FieldError("areaId", "areaId is required");
    const patch = parsePatchFields(body);
    return { ...patch, id: machineId, name: patch.name!, areaId: patch.areaId! };
  });
}

export const BULK_MAX_IDS = 500;

export type MachineBulkAction =
  | { action: "activate"; ids: string[] }
  | { action: "deactivate"; ids: string[] }
  | { action: "move"; ids: string[]; areaId: string; lineId: string | null };

export function parseMachineBulk(body: unknown): ValidationResult<MachineBulkAction> {
  return wrap(() => {
    if (!isRecord(body)) throw new FieldError("body", "request body must be a JSON object");
    const ids = body.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > BULK_MAX_IDS || !ids.every((x) => typeof x === "string" && x !== "")) {
      throw new FieldError("ids", `ids must be a non-empty array of at most ${BULK_MAX_IDS} machine ids`);
    }
    const unique = [...new Set(ids as string[])];
    switch (body.action) {
      case "activate":
      case "deactivate":
        return { action: body.action, ids: unique };
      case "move": {
        const areaId = id("areaId", body.areaId);
        const lineId = body.lineId === undefined || body.lineId === null || body.lineId === "" ? null : id("lineId", body.lineId);
        return { action: "move", ids: unique, areaId, lineId };
      }
      default:
        throw new FieldError("action", `action must be "activate", "deactivate" or "move"`);
    }
  });
}

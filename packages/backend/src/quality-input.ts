/**
 * Minőségellenőrzés — tiszta (adatbázis nélküli) részek: a terv bemenetének
 * ellenőrzése, egy mérés kiértékelése és a mérési sorrend.
 */

export type CheckKind = "first_piece" | "last_piece" | "spot";
export const CHECK_KINDS: readonly CheckKind[] = ["first_piece", "last_piece", "spot"];
export type CharacteristicKind = "variable" | "attribute";

export interface CharacteristicInput {
  name: string;
  kind: CharacteristicKind;
  nominal: number | null;
  lowerLimit: number | null;
  upperLimit: number | null;
  unit: string | null;
  method: string | null;
  pdfFileId: string | null;
  pdfFileName: string | null;
  inFirstPiece: boolean;
  inLastPiece: boolean;
  inSpot: boolean;
}

export interface PlanInput {
  partName: string;
  notes: string | null;
  firstPiece: { enabled: boolean; gatesCounting: boolean };
  lastPiece: { enabled: boolean; gatesCompletion: boolean };
  spot: { enabled: boolean; everyParts: number | null; maxMinutes: number | null; graceMinutes: number };
  characteristics: CharacteristicInput[];
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string; field: string };

export const MAX_CHARACTERISTICS = 100;
const MAX_TEXT = 200;

function bad(field: string, error: string): { ok: false; error: string; field: string } {
  return { ok: false, field, error };
}

function optText(v: unknown, field: string, max = MAX_TEXT): Parsed<string | null> {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v !== "string") return bad(field, "must be text");
  const t = v.trim();
  if (t.length > max) return bad(field, `at most ${max} characters`);
  return { ok: true, value: t === "" ? null : t };
}

function optNumber(v: unknown, field: string): Parsed<number | null> {
  if (v === undefined || v === null || v === "") return { ok: true, value: null };
  const n = typeof v === "string" ? Number(v.replace(",", ".")) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return bad(field, "must be a number");
  return { ok: true, value: n };
}

function optPositiveInt(v: unknown, field: string, max: number): Parsed<number | null> {
  if (v === undefined || v === null || v === "") return { ok: true, value: null };
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > max) return bad(field, `must be a whole number between 1 and ${max}`);
  return { ok: true, value: n };
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function parsePlanInput(body: unknown): Parsed<PlanInput> {
  const b = obj(body);
  const partName = typeof b.partName === "string" ? b.partName.trim() : "";
  if (!partName) return bad("partName", "the part name is required");
  if (partName.length > MAX_TEXT) return bad("partName", `at most ${MAX_TEXT} characters`);
  const notes = optText(b.notes, "notes", 2000);
  if (!notes.ok) return notes;

  const fp = obj(b.firstPiece);
  const lp = obj(b.lastPiece);
  const sp = obj(b.spot);
  const everyParts = optPositiveInt(sp.everyParts, "spot.everyParts", 1_000_000);
  if (!everyParts.ok) return everyParts;
  const maxMinutes = optPositiveInt(sp.maxMinutes, "spot.maxMinutes", 7 * 24 * 60);
  if (!maxMinutes.ok) return maxMinutes;
  const grace = optPositiveInt(sp.graceMinutes, "spot.graceMinutes", 24 * 60);
  if (!grace.ok) return grace;
  const spot = { enabled: bool(sp.enabled, false), everyParts: everyParts.value, maxMinutes: maxMinutes.value, graceMinutes: grace.value ?? 15 };
  if (spot.enabled && spot.everyParts === null && spot.maxMinutes === null) {
    return bad("spot.maxMinutes", "give the number of parts or the longest time between spot checks (or both)");
  }

  if (!Array.isArray(b.characteristics)) return bad("characteristics", "the list of measurements is required");
  if (b.characteristics.length > MAX_CHARACTERISTICS) return bad("characteristics", `at most ${MAX_CHARACTERISTICS} measurements`);
  const characteristics: CharacteristicInput[] = [];
  for (const [i, raw] of b.characteristics.entries()) {
    const c = obj(raw);
    const f = (name: string) => `characteristics.${i}.${name}`;
    const name = typeof c.name === "string" ? c.name.trim() : "";
    if (!name) return bad(f("name"), `measurement ${i + 1}: the name is required`);
    if (name.length > MAX_TEXT) return bad(f("name"), `measurement ${i + 1}: at most ${MAX_TEXT} characters`);
    const kind = c.kind === "attribute" ? "attribute" : c.kind === "variable" || c.kind === undefined ? "variable" : null;
    if (!kind) return bad(f("kind"), `measurement ${i + 1}: the type is variable or attribute`);
    const nominal = optNumber(c.nominal, f("nominal"));
    if (!nominal.ok) return nominal;
    const lower = optNumber(c.lowerLimit, f("lowerLimit"));
    if (!lower.ok) return lower;
    const upper = optNumber(c.upperLimit, f("upperLimit"));
    if (!upper.ok) return upper;
    const unit = optText(c.unit, f("unit"), 20);
    if (!unit.ok) return unit;
    const method = optText(c.method, f("method"));
    if (!method.ok) return method;
    const pdfFileId = optText(c.pdfFileId, f("pdfFileId"));
    if (!pdfFileId.ok) return pdfFileId;
    const pdfFileName = optText(c.pdfFileName, f("pdfFileName"));
    if (!pdfFileName.ok) return pdfFileName;
    if (kind === "variable") {
      if (lower.value === null && upper.value === null) return bad(f("lowerLimit"), `${name}: give the lower or the upper limit (or both)`);
      if (lower.value !== null && upper.value !== null && lower.value > upper.value) return bad(f("upperLimit"), `${name}: the upper limit is below the lower limit`);
      if (nominal.value !== null && ((lower.value !== null && nominal.value < lower.value) || (upper.value !== null && nominal.value > upper.value))) {
        return bad(f("nominal"), `${name}: the nominal value is outside the limits`);
      }
    }
    const item: CharacteristicInput = {
      name,
      kind,
      nominal: kind === "variable" ? nominal.value : null,
      lowerLimit: kind === "variable" ? lower.value : null,
      upperLimit: kind === "variable" ? upper.value : null,
      unit: kind === "variable" ? unit.value : null,
      method: method.value,
      pdfFileId: pdfFileId.value,
      pdfFileName: pdfFileId.value ? (pdfFileName.value ?? "document.pdf") : null,
      inFirstPiece: bool(c.inFirstPiece, true),
      inLastPiece: bool(c.inLastPiece, true),
      inSpot: bool(c.inSpot, true),
    };
    if (!item.inFirstPiece && !item.inLastPiece && !item.inSpot) return bad(f("inSpot"), `${name}: choose at least one check it belongs to`);
    characteristics.push(item);
  }

  const firstPiece = { enabled: bool(fp.enabled, false), gatesCounting: bool(fp.gatesCounting, true) };
  const lastPiece = { enabled: bool(lp.enabled, false), gatesCompletion: bool(lp.gatesCompletion, true) };
  if (firstPiece.enabled && !characteristics.some((c) => c.inFirstPiece)) return bad("firstPiece.enabled", "the first-piece check has no measurement");
  if (lastPiece.enabled && !characteristics.some((c) => c.inLastPiece)) return bad("lastPiece.enabled", "the last-piece check has no measurement");
  if (spot.enabled && !characteristics.some((c) => c.inSpot)) return bad("spot.enabled", "the spot check has no measurement");

  return { ok: true, value: { partName, notes: notes.value, firstPiece, lastPiece, spot, characteristics } };
}

export interface Limits {
  kind: CharacteristicKind;
  lowerLimit: number | null;
  upperLimit: number | null;
}

/** Inside the limits (limits included). An attribute passes when it is OK. */
export function evaluateMeasurement(c: Limits, m: { value?: number | null; ok?: boolean | null }): boolean {
  if (c.kind === "attribute") return m.ok === true;
  const v = m.value;
  if (typeof v !== "number" || !Number.isFinite(v)) return false;
  // Compare with a tiny tolerance so 10.1 typed as text and stored as NUMERIC is not "outside" 10.1.
  const eps = 1e-9;
  if (c.lowerLimit !== null && v < c.lowerLimit - eps) return false;
  if (c.upperLimit !== null && v > c.upperLimit + eps) return false;
  return true;
}

export function includedIn(kind: CheckKind, c: { inFirstPiece: boolean; inLastPiece: boolean; inSpot: boolean }): boolean {
  return kind === "first_piece" ? c.inFirstPiece : kind === "last_piece" ? c.inLastPiece : c.inSpot;
}

/**
 * The measurement to do next: the first characteristic (in order) whose latest attempt did not pass.
 * One at a time: a failed one stays next until it is measured again and passes.
 */
export function nextCharacteristic<C extends { id: string }>(characteristics: readonly C[], latestPassed: ReadonlyMap<string, boolean>): C | undefined {
  return characteristics.find((c) => latestPassed.get(c.id) !== true);
}

/** Parts since the last spot anchor reached the number, or the time is up. Pure. */
export function spotDue(
  plan: { spotEnabled: boolean; spotEveryParts: number | null; spotMaxMinutes: number | null },
  anchor: Date,
  partsSinceAnchor: number,
  now: Date,
): "parts" | "time" | null {
  if (!plan.spotEnabled) return null;
  if (plan.spotEveryParts !== null && partsSinceAnchor >= plan.spotEveryParts) return "parts";
  if (plan.spotMaxMinutes !== null && now.getTime() - anchor.getTime() >= plan.spotMaxMinutes * 60_000) return "time";
  return null;
}

/**
 * Per edge node settings. Pure (no db import) so it is testable without a
 * database. The stored JSON may miss keys or hold garbage; resolveSettings()
 * always returns a complete, valid object.
 */
export interface EdgeNodeSettings {
  /** Longest gap (minutes) whose parts are still booked afterwards by the edge agent; 0 = off. */
  catchupMaxMinutes: number;
}

export const DEFAULT_EDGE_NODE_SETTINGS: EdgeNodeSettings = { catchupMaxMinutes: 10 };
export const CATCHUP_MAX_MINUTES_LIMIT = 1440;

const isMinutes = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= CATCHUP_MAX_MINUTES_LIMIT;

export function resolveSettings(raw: unknown): EdgeNodeSettings {
  const o = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    catchupMaxMinutes: isMinutes(o.catchupMaxMinutes) ? o.catchupMaxMinutes : DEFAULT_EDGE_NODE_SETTINGS.catchupMaxMinutes,
  };
}

export type SettingsPatchResult = { ok: true; patch: Partial<EdgeNodeSettings> } | { ok: false; error: string };

export function validateSettingsPatch(body: unknown): SettingsPatchResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const input = body as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length === 0) return { ok: false, error: "no settings given" };
  const patch: Partial<EdgeNodeSettings> = {};
  for (const key of keys) {
    if (key === "catchupMaxMinutes") {
      if (!isMinutes(input[key])) {
        return { ok: false, error: `catchupMaxMinutes must be an integer between 0 and ${CATCHUP_MAX_MINUTES_LIMIT}` };
      }
      patch.catchupMaxMinutes = input[key] as number;
    } else {
      return { ok: false, error: `unknown setting: ${key}` };
    }
  }
  return { ok: true, patch };
}

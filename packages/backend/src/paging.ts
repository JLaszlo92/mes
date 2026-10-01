/**
 * Közös lekérdezés-paraméterek a szerveroldalon lapozott listákhoz (audit
 * log, riasztás-előzmények, hibajelentések). Válaszforma mindenhol:
 * { rows, total } — a frontend Pager komponense erre épül.
 */

export interface Paging {
  limit: number;
  offset: number;
}

export const MAX_PAGE_SIZE = 200;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; field: string; error: string };

export function parsePaging(query: { limit?: string; offset?: string }, defaultLimit = 50): ParseResult<Paging> {
  const limit = query.limit === undefined || query.limit === "" ? defaultLimit : Number(query.limit);
  const offset = query.offset === undefined || query.offset === "" ? 0 : Number(query.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    return { ok: false, field: "limit", error: `limit must be a whole number between 1 and ${MAX_PAGE_SIZE}` };
  }
  if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) {
    return { ok: false, field: "offset", error: "offset must be a whole number of at least 0" };
  }
  return { ok: true, value: { limit, offset } };
}

/** "a,b,c" → ["a","b","c"]; üres → undefined (= nincs szűrés). Legfeljebb 1000 elem. */
export function parseIdList(field: string, raw: string | undefined): ParseResult<string[] | undefined> {
  if (raw === undefined || raw === "") return { ok: true, value: undefined };
  const ids = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  if (ids.length > 1000) return { ok: false, field, error: `${field} can list at most 1000 ids` };
  return { ok: true, value: ids };
}

/** ISO időpont (opcionális). */
export function parseInstant(field: string, raw: string | undefined): ParseResult<string | undefined> {
  if (raw === undefined || raw === "") return { ok: true, value: undefined };
  const d = new Date(raw);
  if (isNaN(d.getTime())) return { ok: false, field, error: `${field} must be an ISO date-time` };
  return { ok: true, value: d.toISOString() };
}

/** LIKE-mintában a % _ \ karakterek szó szerint értendők. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Előtag-keresés LIKE-hoz, szó szerinti % _ \ karakterekkel. */
export function likePrefix(text: string): string {
  return `${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

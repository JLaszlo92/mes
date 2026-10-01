import { useEffect, useRef, useState } from "react";
import { apiFetch, API_BASE } from "../api.js";
import { readJsonOrThrow } from "../master-data.js";

/**
 * Szerveroldalon lapozott lista betöltése. A szűrők változásakor az első
 * oldalra ugrik; a gépelés okozta sok kérést 300 ms-os késleltetés fogja
 * össze; egy elavult válasz nem írja felül az újabbat.
 *
 * `params` a szűrők (üres érték = nincs szűrés); `toPage` a válaszból
 * kiolvassa a sorokat és az összes darabszámot (az audit log { entries,
 * total }, a többi { rows, total }).
 */
export function useServerList<T, R = { rows: T[]; total: number }>(
  path: string,
  params: Record<string, string | undefined>,
  options: { limit?: number; refreshMs?: number; toPage?: (r: R) => { rows: T[]; total: number }; enabled?: boolean } = {},
) {
  const [page, setPage] = useState({ offset: 0, limit: options.limit ?? 50 });
  const [rows, setRows] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const requestId = useRef(0);
  const enabled = options.enabled ?? true;

  const filterKey = JSON.stringify(params);
  const lastFilterKey = useRef(filterKey);

  useEffect(() => {
    if (!enabled) return;
    // Új szűrés → első oldal (a lapozás nem marad egy már nem létező oldalon).
    let offset = page.offset;
    if (lastFilterKey.current !== filterKey) {
      lastFilterKey.current = filterKey;
      if (page.offset !== 0) {
        setPage((p) => ({ ...p, offset: 0 }));
        return;
      }
      offset = 0;
    }
    const id = ++requestId.current;
    const timer = setTimeout(() => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, v);
      qs.set("limit", String(page.limit));
      qs.set("offset", String(offset));
      setLoading(true);
      apiFetch(`${API_BASE}${path}?${qs}`)
        .then((r) => readJsonOrThrow<R>(r))
        .then((body) => {
          if (id !== requestId.current) return;
          const p = options.toPage ? options.toPage(body) : (body as unknown as { rows: T[]; total: number });
          setRows(p.rows);
          setTotal(p.total);
          setError(null);
        })
        .catch((err) => id === requestId.current && setError(err instanceof Error ? err.message : String(err)))
        .finally(() => id === requestId.current && setLoading(false));
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, filterKey, page.offset, page.limit, tick, enabled]);

  useEffect(() => {
    if (!options.refreshMs || !enabled) return;
    const t = setInterval(() => setTick((n) => n + 1), options.refreshMs);
    return () => clearInterval(t);
  }, [options.refreshMs, enabled]);

  return {
    rows,
    total,
    loading,
    error,
    offset: page.offset,
    limit: page.limit,
    setPage,
    reload: () => setTick((n) => n + 1),
  };
}

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { apiFetch, API_BASE } from "./api.js";
import { readJsonOrThrow, useMasterDataVersion, type Machine, type PlantHierarchy } from "./master-data.js";

/**
 * Globális hatókör: telephely → részleg → sor. A felső sáv választójával
 * állítható, és minden gépfüggő nézet ezzel szűr (Overview, Gantt, rendelések,
 * karbantartás, riasztások, géplista).
 *
 * Szándékosan MEGJELENÍTÉSI szűrő, nem jogosultság: a backend minden adatot
 * visszaad, amihez a felhasználónak joga van. A felhasználónkénti
 * hatókör-korlátozás (PRD 5.8) később szerveroldalon jön, erre a
 * hierarchiára építve.
 *
 * A választás böngészőnként megmarad (localStorage).
 */

export interface Scope {
  siteId: string | null;
  areaId: string | null;
  lineId: string | null;
}

const EMPTY: Scope = { siteId: null, areaId: null, lineId: null };
const STORAGE_KEY = "mes.scope";

interface ScopeContextValue {
  scope: Scope;
  setScope: (next: Scope) => void;
  hierarchy: PlantHierarchy;
  /** Minden gép (aktív és deaktivált), a hatókörtől függetlenül. */
  machines: Machine[];
  /** Benne van-e a gép a hatókörben. Ismeretlen gép vagy null (rendszerriasztás) → igen. */
  isInScope: (machineId: string | null | undefined) => boolean;
  /** Van-e szűkítés egyáltalán. */
  isFiltered: boolean;
  /** Rövid címke a felső sávhoz, pl. "Budapest / Assembly". */
  label: string;
}

const ScopeContext = createContext<ScopeContextValue | null>(null);

function readStored(): Scope {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const v = JSON.parse(raw) as Partial<Scope>;
    return { siteId: v.siteId ?? null, areaId: v.areaId ?? null, lineId: v.lineId ?? null };
  } catch {
    return EMPTY;
  }
}

export function ScopeProvider({ children }: { children: ReactNode }) {
  const version = useMasterDataVersion();
  const [scope, setScopeState] = useState<Scope>(readStored);
  const [hierarchy, setHierarchy] = useState<PlantHierarchy>({ sites: [], areas: [], lines: [] });
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    Promise.all([
      apiFetch(`${API_BASE}/api/plant-hierarchy`).then((r) => readJsonOrThrow<PlantHierarchy>(r)),
      apiFetch(`${API_BASE}/api/machine-registry`).then((r) => readJsonOrThrow<Machine[]>(r)),
    ])
      .then(([h, m]) => {
        setHierarchy(h);
        setMachines(m);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [version]);

  const setScope = useCallback((next: Scope) => {
    setScopeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* nem baj, csak nem jegyzi meg */
    }
  }, []);

  // Egy törölt telephely/részleg/sor ne ragadjon be a mentett hatókörbe.
  useEffect(() => {
    if (!loaded) return;
    const siteOk = !scope.siteId || hierarchy.sites.some((s) => s.id === scope.siteId);
    const areaOk = !scope.areaId || hierarchy.areas.some((a) => a.id === scope.areaId);
    const lineOk = !scope.lineId || hierarchy.lines.some((l) => l.id === scope.lineId);
    if (!siteOk || !areaOk || !lineOk) setScope(EMPTY);
  }, [loaded, hierarchy, scope, setScope]);

  const value = useMemo<ScopeContextValue>(() => {
    const byId = new Map(machines.map((m) => [m.id, m]));
    const matches = (m: Machine) =>
      (!scope.siteId || m.siteId === scope.siteId) && (!scope.areaId || m.areaId === scope.areaId) && (!scope.lineId || m.lineId === scope.lineId);
    const isFiltered = !!(scope.siteId || scope.areaId || scope.lineId);
    const parts = [
      scope.siteId ? hierarchy.sites.find((s) => s.id === scope.siteId)?.name : null,
      scope.areaId ? hierarchy.areas.find((a) => a.id === scope.areaId)?.name : null,
      scope.lineId ? hierarchy.lines.find((l) => l.id === scope.lineId)?.name : null,
    ].filter(Boolean);
    return {
      scope,
      setScope,
      hierarchy,
      machines,
      isFiltered,
      label: parts.length > 0 ? parts.join(" / ") : "All sites",
      isInScope: (machineId) => {
        if (!isFiltered || !machineId) return true;
        const m = byId.get(machineId);
        // Még nem ismert gép (pl. épp most regisztrált) ne tűnjön el csendben.
        return m ? matches(m) : true;
      },
    };
  }, [scope, setScope, hierarchy, machines]);

  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

export function useScope(): ScopeContextValue {
  const ctx = useContext(ScopeContext);
  if (!ctx) throw new Error("useScope must be used inside <ScopeProvider>");
  return ctx;
}

import { useEffect, useState } from "react";

/**
 * Egyszerű értesítés a törzsadatok (gépek, hierarchia) változásáról: a
 * hierarchia-panel egy új sor létrehozása után szól, a géplista pedig
 * újratölti a választóit. Egyetlen folyamaton belüli, függőség nélküli
 * pub/sub — globális store helyett, amíg ennyi elég.
 */
const listeners = new Set<() => void>();

export function notifyMasterDataChanged(): void {
  for (const l of listeners) l();
}

/** Minden változáskor nő — useEffect függőségnek. */
export function useMasterDataVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const l = () => setVersion((v) => v + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return version;
}

export interface Site {
  id: string;
  name: string;
  areaCount: number;
  machineCount: number;
}
export interface Area {
  id: string;
  siteId: string;
  name: string;
  lineCount: number;
  machineCount: number;
}
export interface Line {
  id: string;
  areaId: string;
  name: string;
  machineCount: number;
}
export interface PlantHierarchy {
  sites: Site[];
  areas: Area[];
  lines: Line[];
}

export interface Machine {
  id: string;
  name: string;
  assetType: string | null;
  location: string | null;
  idealCycleTimeSeconds: number | null;
  isActive: boolean;
  siteId: string;
  areaId: string;
  lineId: string | null;
  shiftPatternId: string | null;
  calendarId: string | null;
  autoOffshiftStatus: boolean;
  microStopThresholdSeconds: number;
}

/** A backend hibaválaszából ({ error, field }) olvasható hiba. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly field?: string,
  ) {
    super(message);
  }
}

export async function readJsonOrThrow<T>(res: Response): Promise<T> {
  if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T;
  const body = (await res.json().catch(() => ({}))) as { error?: string; field?: string };
  throw new ApiError(body.error ?? `${res.status} ${res.statusText}`, res.status, body.field);
}

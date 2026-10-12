/**
 * Nyomonkövetés — közös típusok és segédek a Lots és a Material lots
 * oldalnak. A két oldal egymásra hivatkozik (`?open=` paraméterrel nyílik a
 * másik oldal oldalpanelje), így a lánc mindkét irányban bejárható:
 * késztermék-tétel → alapanyag, alapanyag → work orderek és késztermékek.
 */
import { navigate } from "./router.js";

export interface LotMaterial {
  materialLotId: string;
  materialName: string;
  lotNumber: string;
  supplier: string | null;
  receivedAt: string | null;
}

export interface Lot {
  id: string;
  lotNumber: string;
  workOrderId: string;
  orderNumber: string;
  partName: string;
  quantity: number;
  machineId: string | null;
  machineName: string | null;
  operatorEmail: string | null;
  startedAt: string | null;
  completedAt: string;
  goodCount: number;
  scrapCount: number;
  materials: LotMaterial[];
}

export interface MaterialLot {
  id: string;
  materialName: string;
  lotNumber: string;
  supplier: string | null;
  receivedAt: string | null;
  createdAt: string;
  workOrderCount: number;
  finishedLotCount: number;
  lastUsedAt: string | null;
}

export interface MaterialLotUsage {
  workOrderId: string;
  orderNumber: string;
  partName: string;
  workOrderStatus: string;
  recordedAt: string;
  recordedByEmail: string | null;
  lot: { lotNumber: string; goodCount: number; scrapCount: number; completedAt: string; machineName: string | null } | null;
}

/** "3.2 %" — or "—" when nothing was produced. */
export function scrapRate(good: number, scrap: number): string {
  const total = good + scrap;
  if (total === 0) return "—";
  return `${((scrap / total) * 100).toFixed(1)} %`;
}

export function openLot(lotNumber: string): void {
  navigate(`/production/lots?open=${encodeURIComponent(lotNumber)}`);
}

export function openMaterialLot(id: string): void {
  navigate(`/production/materials?open=${encodeURIComponent(id)}`);
}

/**
 * Reads `?open=` once when a page mounts and removes it from the address bar,
 * so a reload or the back button does not reopen the drawer by surprise.
 */
export function takeOpenParam(): string | null {
  const params = new URLSearchParams(window.location.search);
  const value = params.get("open");
  if (value !== null) window.history.replaceState(null, "", window.location.pathname);
  return value;
}

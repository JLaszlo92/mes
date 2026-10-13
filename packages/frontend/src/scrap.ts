/** Selejt — közös típusok és hívások a dashboard számára. */
import { apiFetch, API_BASE } from "./api.js";
import { readJsonOrThrow } from "./master-data.js";

export type ScrapMode = "reclassify" | "additional";

export interface ScrapReason {
  id: string;
  machineId: string | null;
  code: string;
  name: string;
  isActive: boolean;
}

export interface ScrapByReason {
  code: string | null;
  name: string;
  quantity: number;
  booked: number;
}

export interface ScrapAnalysis {
  totalScrap: number;
  totalGood: number;
  byReason: ScrapByReason[];
  byMachine: { machineId: string; machineName: string; good: number; scrap: number; byReason: ScrapByReason[] }[];
}

export interface ScrapBooking {
  id: string;
  machineId: string;
  machineName: string | null;
  workOrderId: string | null;
  orderNumber: string | null;
  partName: string | null;
  reasonCode: string;
  reasonName: string;
  quantity: number;
  mode: ScrapMode;
  note: string | null;
  bookedByName: string | null;
  terminalName: string | null;
  bookedAt: string;
}

export const MODE_LABEL: Record<ScrapMode, string> = {
  reclassify: "Taken off the good parts",
  additional: "Added as extra scrap",
};

const json = { "Content-Type": "application/json" };

export const scrapApi = {
  reasons: () => apiFetch(`${API_BASE}/api/scrap-reasons`).then((r) => readJsonOrThrow<ScrapReason[]>(r)),
  createReason: (body: { machineId?: string; code: string; name: string }) =>
    apiFetch(`${API_BASE}/api/scrap-reasons`, { method: "POST", headers: json, body: JSON.stringify(body) }).then((r) => readJsonOrThrow<ScrapReason>(r)),
  updateReason: (id: string, body: { name?: string; isActive?: boolean }) =>
    apiFetch(`${API_BASE}/api/scrap-reasons/${encodeURIComponent(id)}`, { method: "PATCH", headers: json, body: JSON.stringify(body) }).then((r) => readJsonOrThrow<ScrapReason>(r)),
  deleteReason: (id: string) =>
    apiFetch(`${API_BASE}/api/scrap-reasons/${encodeURIComponent(id)}`, { method: "DELETE" }).then((r) => {
      if (!r.ok && r.status !== 204) return readJsonOrThrow(r);
      return null;
    }),
  modes: () => apiFetch(`${API_BASE}/api/scrap-modes`).then((r) => readJsonOrThrow<{ machineId: string; machineName: string; mode: ScrapMode; isActive: boolean }[]>(r)),
  setMode: (machineId: string, mode: ScrapMode) =>
    apiFetch(`${API_BASE}/api/machine-registry/${encodeURIComponent(machineId)}/scrap-mode`, { method: "PUT", headers: json, body: JSON.stringify({ mode }) }).then((r) => readJsonOrThrow(r)),
  analysis: (params: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
    return apiFetch(`${API_BASE}/api/scrap/analysis?${q}`).then((r) => readJsonOrThrow<ScrapAnalysis>(r));
  },
  bookings: (params: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
    return apiFetch(`${API_BASE}/api/scrap-bookings?${q}`).then((r) => readJsonOrThrow<{ rows: ScrapBooking[]; total: number }>(r));
  },
};

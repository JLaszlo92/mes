import { assessDisks, usedPercent } from "./disk-health.js";

/** The disk figures an agent (v9 and later) sends with the claim and the heartbeat. */
export interface DiskReport {
  usedBytes: number;
  availBytes: number;
}

const isByteCount = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER;

/** Anything that is not two non-negative byte counts (an older agent sends nothing) gives null. */
export function parseDiskReport(value: unknown): DiskReport | null {
  if (typeof value !== "object" || value === null) return null;
  const { usedBytes, availBytes } = value as Record<string, unknown>;
  if (!isByteCount(usedBytes) || !isByteCount(availBytes)) return null;
  return { usedBytes: Math.round(usedBytes), availBytes: Math.round(availBytes) };
}

/** A stored bigint arrives from pg as a string. */
function storedBytes(value: unknown): number | null {
  if (typeof value === "number") return isByteCount(value) ? value : null;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const n = Number(value);
    return isByteCount(n) ? n : null;
  }
  return null;
}

/** The disk fields of an edge node as the API returns them. */
export function diskView(usedRaw: unknown, availRaw: unknown): {
  diskUsedBytes: number | null;
  diskAvailBytes: number | null;
  diskUsedPercent: number | null;
  diskLow: boolean;
} {
  const used = storedBytes(usedRaw);
  const avail = storedBytes(availRaw);
  if (used === null || avail === null) return { diskUsedBytes: null, diskAvailBytes: null, diskUsedPercent: null, diskLow: false };
  const volume = { label: "disk", usedBytes: used, availBytes: avail };
  return {
    diskUsedBytes: used,
    diskAvailBytes: avail,
    diskUsedPercent: usedPercent(volume),
    diskLow: !assessDisks([volume], false).healthy,
  };
}

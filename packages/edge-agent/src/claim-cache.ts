import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Last successfully claimed channel configuration, kept next to the event buffer.
 *
 * Lets the edge agent start (and keep counting) when the backend cannot be reached
 * at start time: the claim response is the only place the channel configuration
 * comes from, so without this copy a node that boots while the network is down
 * cannot start at all (chaos finding 21).
 *
 * The file holds connection settings of the machines, so it is written 0600, and it
 * is bound to the node token (only a hash is stored) so a copy from another node or
 * after a token change is never used.
 */

const CACHE_VERSION = 1;

export interface CachedClaim {
  channels: Array<{ machineId: string; signalSource: string; [key: string]: unknown }>;
  settings: { catchupMaxMinutes: number };
}

export type CacheLoadResult =
  | { ok: true; value: CachedClaim; savedAtMs: number }
  | { ok: false; reason: "missing" | "unreadable" | "invalid" | "other-node" | "expired" };

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isChannel(value: unknown): value is CachedClaim["channels"][number] {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.machineId === "string" && v.machineId.length > 0 && typeof v.signalSource === "string";
}

export class ClaimCache {
  /** maxAgeMs = 0 means "no age limit". */
  constructor(
    private readonly filePath: string,
    private readonly maxAgeMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Atomic (temp file + fsync + rename): a power cut leaves either the old or the new file, never half of one. */
  async save(token: string, value: CachedClaim): Promise<void> {
    const body = JSON.stringify({ version: CACHE_VERSION, savedAtMs: this.now(), tokenHash: tokenHash(token), ...value });
    const tmp = `${this.filePath}.tmp`;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const handle = await fs.open(tmp, "w", 0o600);
    try {
      await handle.writeFile(body, "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, this.filePath);
  }

  /** Never throws: any problem is a reason why the cache cannot be used. */
  async load(token: string): Promise<CacheLoadResult> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf-8");
    } catch (err) {
      return { ok: false, reason: (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" };
    }
    let data: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return { ok: false, reason: "invalid" };
      data = parsed as Record<string, unknown>;
    } catch {
      return { ok: false, reason: "invalid" };
    }
    if (data.version !== CACHE_VERSION || typeof data.savedAtMs !== "number" || !Array.isArray(data.channels)) {
      return { ok: false, reason: "invalid" };
    }
    if (data.tokenHash !== tokenHash(token)) return { ok: false, reason: "other-node" };
    const settings = data.settings as { catchupMaxMinutes?: unknown } | undefined;
    const minutes = settings?.catchupMaxMinutes;
    if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 0 || minutes > 1440) {
      return { ok: false, reason: "invalid" };
    }
    if (!data.channels.every(isChannel)) return { ok: false, reason: "invalid" };
    if (this.maxAgeMs > 0 && this.now() - data.savedAtMs > this.maxAgeMs) return { ok: false, reason: "expired" };
    return {
      ok: true,
      savedAtMs: data.savedAtMs,
      value: { channels: data.channels, settings: { catchupMaxMinutes: minutes } },
    };
  }
}

/**
 * Cache of the machine ids in the `machines` table. The MQTT subscriber uses
 * it to reject events from machines that are not registered, without a
 * database query per event.
 *
 * - A registered id is trusted for `ttlMs`; after that the whole set is
 *   reloaded (a deleted machine stops being accepted within that time).
 * - An unknown id triggers at most one reload per `missRefreshMs`, so a
 *   machine that was just registered is accepted within seconds, while a
 *   flood of random ids costs one query per interval.
 * - Concurrent lookups share one reload. If the reload fails, the lookup
 *   rejects (the caller must not ack the event; the sender retries).
 */
export interface MachineRegistryCache {
  isRegistered(machineId: string): Promise<boolean>;
}

export function createMachineRegistryCache(
  load: () => Promise<string[]>,
  now: () => number = Date.now,
  ttlMs = 30_000,
  missRefreshMs = 3_000,
): MachineRegistryCache {
  let known = new Set<string>();
  let loadedAt = Number.NEGATIVE_INFINITY;
  let inflight: Promise<void> | null = null;

  function refresh(): Promise<void> {
    if (!inflight) {
      inflight = load()
        .then((ids) => {
          known = new Set(ids);
          loadedAt = now();
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  }

  return {
    async isRegistered(machineId: string): Promise<boolean> {
      if (now() - loadedAt > ttlMs) await refresh();
      if (known.has(machineId)) return true;
      if (now() - loadedAt > missRefreshMs) await refresh();
      return known.has(machineId);
    },
  };
}

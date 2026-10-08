import { createHash } from "node:crypto";

/**
 * Revision of what an edge agent runs on: its channels and its settings. The claim and every heartbeat answer carry it;
 * an agent that sees a different revision than the one it claimed with restarts itself, so a change made in the
 * dashboard is picked up without a manual restart. Only the fields the agent actually uses count (a renamed machine
 * or a re-ordered list must not restart anything), and the text is canonical (sorted keys, sorted channels).
 */
export interface RevisionChannel {
  machineId: string | null;
  signalSource: unknown;
  connectionConfig?: unknown;
  statusMode: unknown;
  noSignalTimeoutSeconds: unknown;
  acceptProductionWhileDown: unknown;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function configRevision(channels: ReadonlyArray<RevisionChannel>, settings: unknown): string {
  const used = channels
    .filter((c) => !!c.machineId) // the agent skips channels without a machine
    .map((c) =>
      canonical({
        machineId: c.machineId,
        signalSource: c.signalSource,
        connectionConfig: c.connectionConfig ?? {},
        statusMode: c.statusMode,
        noSignalTimeoutSeconds: c.noSignalTimeoutSeconds,
        acceptProductionWhileDown: c.acceptProductionWhileDown,
      }),
    )
    .sort();
  return createHash("sha256").update(canonical({ channels: used, settings })).digest("hex").slice(0, 16);
}

/**
 * Decides how the edge agent starts. Pure (no I/O), so it is unit-tested.
 *
 *  - EDGE_NODE_TOKEN set      -> registry mode (the normal, supported mode)
 *  - EDGE_AGENT_LEGACY=true   -> legacy single-machine mode (MACHINE_ID, no registry)
 *  - neither                  -> refuse to start
 *
 * Before edge-agent-v4 a missing token silently fell back to legacy mode with
 * the default machine id "sim-machine-01", so a forgotten token made a real
 * node publish events for a made-up machine. Legacy mode now has to be asked
 * for explicitly.
 */

export type StartMode =
  | { mode: "registry"; token: string }
  | { mode: "legacy" }
  | { mode: "refuse"; reason: string };

/** Exit code for "configuration error" (EX_CONFIG); lets systemd be told not to restart on it. */
export const EXIT_CONFIG = 78;

export function legacyFlagFromEnv(raw: string | undefined): boolean {
  const value = (raw ?? "false").toLowerCase();
  if (value !== "true" && value !== "false") {
    // A typo must not silently enable (or disable) the legacy mode.
    throw new Error(`EDGE_AGENT_LEGACY must be "true" or "false" (got "${raw}")`);
  }
  return value === "true";
}

export function decideStartMode(token: string | undefined, legacyFlag: boolean): StartMode {
  if (token) return { mode: "registry", token };
  if (legacyFlag) return { mode: "legacy" };
  return {
    mode: "refuse",
    reason:
      "EDGE_NODE_TOKEN is not set - refusing to start. Create the edge node in the MES UI and put its token in " +
      "/etc/mes/edge-node.env (EDGE_NODE_TOKEN=...). For the old single-machine simulator mode set " +
      "EDGE_AGENT_LEGACY=true explicitly.",
  };
}

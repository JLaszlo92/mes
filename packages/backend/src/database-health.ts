import { pool } from "./db.js";

/**
 * "Can the backend reach its database right now?" for GET /health?db=1 (the dashboard banner polls it while the
 * database is down). A plain SELECT 1 with a short time limit: a connection that hangs counts as down.
 */
export async function databaseHealthy(
  query: () => Promise<unknown> = () => pool.query("SELECT 1"),
  timeoutMs: number = 2000,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      query(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("database health check timed out")), timeoutMs);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

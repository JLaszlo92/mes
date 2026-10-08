import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Hands the clock correction (ms to add to the device clock) to the S7 Python bridge, which cannot see
 * the agent's corrected clock: the bridge re-reads this file about once a second. The write is atomic
 * (temp file + rename), so the bridge never reads half a number.
 */
export async function writeClockOffsetFile(filePath: string, offsetMs: number): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, String(Math.round(offsetMs)), "utf-8");
  await fs.rename(tmp, filePath);
}

import { statfs } from "node:fs/promises";
import path from "node:path";

/** Used and available bytes of the file system that holds the event buffer. */
export interface DiskUsage {
  usedBytes: number;
  availBytes: number;
}

/**
 * Reads the disk of the directory of `filePath` (the buffer file). Never throws:
 * a failure only means the figures are left out of this claim or heartbeat.
 */
export async function readDiskUsage(filePath: string): Promise<DiskUsage | undefined> {
  try {
    const fs = await statfs(path.dirname(filePath));
    return { usedBytes: (fs.blocks - fs.bfree) * fs.bsize, availBytes: fs.bavail * fs.bsize };
  } catch {
    return undefined;
  }
}

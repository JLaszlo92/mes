import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readDiskUsage } from "../disk-usage.js";

describe("readDiskUsage", () => {
  it("reads the disk of the directory of the file", async () => {
    const usage = await readDiskUsage(path.join(os.tmpdir(), "mes-edge-buffer.ndjson"));
    expect(usage).toBeDefined();
    expect(usage!.usedBytes).toBeGreaterThanOrEqual(0);
    expect(usage!.availBytes).toBeGreaterThanOrEqual(0);
    expect(usage!.usedBytes + usage!.availBytes).toBeGreaterThan(0);
  });

  it("returns undefined instead of throwing for a missing directory", async () => {
    expect(await readDiskUsage("/definitely/not/there/buffer.ndjson")).toBeUndefined();
  });
});

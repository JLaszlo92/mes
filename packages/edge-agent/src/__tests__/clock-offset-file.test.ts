import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeClockOffsetFile } from "../clock-offset-file.js";

describe("writeClockOffsetFile", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "clock-offset-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("writes the correction as a plain integer, creating the directory", async () => {
    const file = path.join(dir, "sub", "clock-offset");
    await writeClockOffsetFile(file, 300_051);
    expect(await readFile(file, "utf-8")).toBe("300051");
  });

  it("writes negative and zero values and overwrites the previous one", async () => {
    const file = path.join(dir, "clock-offset");
    await writeClockOffsetFile(file, 300_051);
    await writeClockOffsetFile(file, -120_000);
    expect(await readFile(file, "utf-8")).toBe("-120000");
    await writeClockOffsetFile(file, 0);
    expect(await readFile(file, "utf-8")).toBe("0");
  });

  it("rounds and leaves no temp file behind", async () => {
    const file = path.join(dir, "clock-offset");
    await writeClockOffsetFile(file, 1234.6);
    expect(await readFile(file, "utf-8")).toBe("1235");
    expect(await readdir(dir)).toEqual(["clock-offset"]);
  });
});

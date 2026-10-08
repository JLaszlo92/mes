import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaimCache, type CachedClaim } from "../claim-cache.js";

const claim: CachedClaim = {
  channels: [
    { machineId: "m-1", signalSource: "s7", connectionConfig: { ip: "10.0.0.5" }, statusMode: "status_bit", noSignalTimeoutSeconds: 60, acceptProductionWhileDown: true },
    { machineId: "m-2", signalSource: "modbus", connectionConfig: {}, statusMode: "signal_presence", noSignalTimeoutSeconds: 30, acceptProductionWhileDown: false },
  ],
  settings: { catchupMaxMinutes: 10 },
};

describe("ClaimCache", () => {
  let dir: string;
  let file: string;
  let clock: number;
  const make = (maxAgeMs = 0) => new ClaimCache(file, maxAgeMs, () => clock);

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "claim-cache-"));
    file = path.join(dir, "sub", "claim-cache.json");
    clock = 1_000_000;
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("round-trips a saved claim", async () => {
    await make().save("tok", claim);
    const res = await make().load("tok");
    expect(res).toEqual({ ok: true, value: claim, savedAtMs: 1_000_000 });
  });

  it("does not store the token itself, writes 0600 and leaves no temp file", async () => {
    await make().save("super-secret-token", claim);
    expect(await readFile(file, "utf-8")).not.toContain("super-secret-token");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(path.dirname(file))).toEqual(["claim-cache.json"]);
  });

  it("overwrites an older cache with the newer claim", async () => {
    await make().save("tok", claim);
    await make().save("tok", { ...claim, settings: { catchupMaxMinutes: 5 } });
    const res = await make().load("tok");
    expect(res.ok && res.value.settings.catchupMaxMinutes).toBe(5);
  });

  it("reports a missing file", async () => {
    expect(await make().load("tok")).toEqual({ ok: false, reason: "missing" });
  });

  it("refuses a cache that belongs to another token", async () => {
    await make().save("tok-a", claim);
    expect(await make().load("tok-b")).toEqual({ ok: false, reason: "other-node" });
  });

  it("refuses corrupt or truncated files without throwing", async () => {
    await make().save("tok", claim);
    const good = await readFile(file, "utf-8");
    for (const bad of ["", "{", good.slice(0, good.length / 2), "null", "[]", '"x"']) {
      await writeFile(file, bad);
      expect(await make().load("tok")).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("refuses an unknown version, bad settings and malformed channels", async () => {
    await make().save("tok", claim);
    const good = JSON.parse(await readFile(file, "utf-8"));
    const variants = [
      { ...good, version: 2 },
      { ...good, settings: { catchupMaxMinutes: -1 } },
      { ...good, settings: { catchupMaxMinutes: 1.5 } },
      { ...good, settings: undefined },
      { ...good, channels: [{ signalSource: "s7" }] },
      { ...good, channels: [{ machineId: "", signalSource: "s7" }] },
      { ...good, channels: "nope" },
    ];
    for (const v of variants) {
      await writeFile(file, JSON.stringify(v));
      expect(await make().load("tok")).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("accepts an empty channel list (a node with nothing assigned)", async () => {
    await make().save("tok", { channels: [], settings: { catchupMaxMinutes: 0 } });
    const res = await make().load("tok");
    expect(res.ok && res.value.channels).toEqual([]);
  });

  it("applies the age limit, and 0 means unlimited", async () => {
    await make(60_000).save("tok", claim);
    clock += 60_000;
    expect((await make(60_000).load("tok")).ok).toBe(true);
    clock += 1;
    expect(await make(60_000).load("tok")).toEqual({ ok: false, reason: "expired" });
    expect((await make(0).load("tok")).ok).toBe(true);
  });

  it("does not expire a cache saved 'in the future' (clock was corrected backwards)", async () => {
    await make(60_000).save("tok", claim);
    clock -= 3_600_000;
    expect((await make(60_000).load("tok")).ok).toBe(true);
  });
});

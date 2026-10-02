import { describe, expect, it } from "vitest";
import { createMachineRegistryCache } from "../machine-registry-cache.js";

function setup(initial: string[]) {
  let t = 0;
  let loads = 0;
  let ids = initial;
  let fail = false;
  const cache = createMachineRegistryCache(
    async () => {
      loads += 1;
      if (fail) throw new Error("db down");
      return ids;
    },
    () => t,
  );
  return {
    cache,
    advance: (ms: number) => {
      t += ms;
    },
    setIds: (next: string[]) => {
      ids = next;
    },
    setFail: (v: boolean) => {
      fail = v;
    },
    loads: () => loads,
  };
}

describe("machine registry cache", () => {
  it("accepts registered ids and rejects unknown ones", async () => {
    const s = setup(["m1", "m2"]);
    expect(await s.cache.isRegistered("m1")).toBe(true);
    expect(await s.cache.isRegistered("nope")).toBe(false);
  });

  it("accepts a newly registered machine within the miss-refresh interval", async () => {
    const s = setup(["m1"]);
    expect(await s.cache.isRegistered("m2")).toBe(false);
    s.setIds(["m1", "m2"]);
    s.advance(1_000);
    expect(await s.cache.isRegistered("m2")).toBe(false); // too soon to reload
    s.advance(3_000);
    expect(await s.cache.isRegistered("m2")).toBe(true);
  });

  it("costs at most one reload per interval under a flood of unknown ids", async () => {
    const s = setup(["m1"]);
    await s.cache.isRegistered("m1");
    s.advance(3_001);
    for (let i = 0; i < 200; i++) await s.cache.isRegistered("junk-" + i);
    expect(s.loads()).toBe(2);
  });

  it("shares one reload between concurrent lookups", async () => {
    const s = setup(["m1"]);
    const results = await Promise.all(Array.from({ length: 10 }, () => s.cache.isRegistered("m1")));
    expect(results.every(Boolean)).toBe(true);
    expect(s.loads()).toBe(1);
  });

  it("reloads after the ttl so a removed machine stops being accepted", async () => {
    const s = setup(["m1"]);
    expect(await s.cache.isRegistered("m1")).toBe(true);
    s.setIds([]);
    s.advance(31_000);
    expect(await s.cache.isRegistered("m1")).toBe(false);
  });

  it("rejects when the reload fails and recovers afterwards", async () => {
    const s = setup(["m1"]);
    s.setFail(true);
    await expect(s.cache.isRegistered("m1")).rejects.toThrow("db down");
    s.setFail(false);
    expect(await s.cache.isRegistered("m1")).toBe(true);
  });
});

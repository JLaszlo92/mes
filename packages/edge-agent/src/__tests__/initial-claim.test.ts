import { describe, expect, it } from "vitest";
import { ClaimHttpError } from "../offline-claim.js";
import { claimWaitingOutRejection } from "../initial-claim.js";

/** A fake clock: sleep advances it, so the whole 150 s grace runs instantly. */
function clock() {
  let t = 1_000_000;
  const waits: number[] = [];
  return {
    waits,
    now: () => t,
    sleep: async (ms: number) => {
      waits.push(ms);
      t += ms;
    },
  };
}

describe("claimWaitingOutRejection", () => {
  it("returns the claim without waiting when it works at once", async () => {
    const c = clock();
    const value = await claimWaitingOutRejection({ claim: async () => "ok", ...c });
    expect(value).toBe("ok");
    expect(c.waits).toEqual([]);
  });

  it("waits out a lease that expires (409, then success) with the backoff 5, 10, 20 s", async () => {
    const c = clock();
    let calls = 0;
    const seen: number[] = [];
    const value = await claimWaitingOutRejection({
      claim: async () => {
        calls += 1;
        if (calls <= 3) throw new ClaimHttpError(409, "lease held");
        return "claimed";
      },
      onRejected: (_e, ms) => seen.push(ms),
      ...c,
    });
    expect(value).toBe("claimed");
    expect(c.waits).toEqual([5_000, 10_000, 20_000]);
    expect(seen).toEqual([5_000, 10_000, 20_000]);
  });

  it("gives up with the last error once the rejection has lasted the grace period", async () => {
    const c = clock();
    let calls = 0;
    await expect(
      claimWaitingOutRejection({
        claim: async () => {
          calls += 1;
          throw new ClaimHttpError(401, `invalid token #${calls}`);
        },
        ...c,
      }),
    ).rejects.toThrow(/invalid token #7/);
    // attempts at 0, 5, 15, 35, 75, 135 s still wait; the one at 195 s finds the rejection older than 150 s
    expect(c.waits).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
    expect(calls).toBe(7);
  });

  it("throws an unreachable backend at once (the caller starts from the cache)", async () => {
    const c = clock();
    let calls = 0;
    await expect(
      claimWaitingOutRejection({
        claim: async () => {
          calls += 1;
          throw new ClaimHttpError(503, "down");
        },
        ...c,
      }),
    ).rejects.toThrow("down");
    expect(calls).toBe(1);
    expect(c.waits).toEqual([]);
  });

  it("a network error (no HTTP answer) is unreachable too", async () => {
    const c = clock();
    await expect(claimWaitingOutRejection({ claim: async () => { throw new TypeError("fetch failed"); }, ...c })).rejects.toThrow("fetch failed");
    expect(c.waits).toEqual([]);
  });

  it("a rejection followed by an unreachable backend ends the wait (offline start allowed)", async () => {
    const c = clock();
    let calls = 0;
    await expect(
      claimWaitingOutRejection({
        claim: async () => {
          calls += 1;
          throw calls === 1 ? new ClaimHttpError(409, "lease held") : new ClaimHttpError(502, "bad gateway");
        },
        ...c,
      }),
    ).rejects.toThrow("bad gateway");
    expect(c.waits).toEqual([5_000]);
  });

  it("honours a shorter grace period", async () => {
    const c = clock();
    let calls = 0;
    await expect(
      claimWaitingOutRejection({
        claim: async () => {
          calls += 1;
          throw new ClaimHttpError(409, "held");
        },
        rejectionGraceMs: 10_000,
        ...c,
      }),
    ).rejects.toThrow("held");
    expect(c.waits).toEqual([5_000, 10_000]);
    expect(calls).toBe(3);
  });
});

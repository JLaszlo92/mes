import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ClaimHttpError,
  REJECTION_GRACE_MS,
  classifyClaimFailure,
  nextBackoffMs,
  sameChannels,
  startBackgroundClaim,
} from "../offline-claim.js";

describe("classifyClaimFailure", () => {
  it("treats network-level failures as unreachable", () => {
    expect(classifyClaimFailure(new TypeError("fetch failed"))).toBe("unreachable");
    expect(classifyClaimFailure(Object.assign(new Error("timeout"), { name: "TimeoutError" }))).toBe("unreachable");
    expect(classifyClaimFailure("whatever")).toBe("unreachable");
  });
  it("treats server trouble as unreachable", () => {
    for (const s of [500, 502, 503, 504, 408, 429]) expect(classifyClaimFailure(new ClaimHttpError(s, "x"))).toBe("unreachable");
  });
  it("treats an answer of 'no' as rejected", () => {
    for (const s of [400, 401, 403, 404, 409, 423]) expect(classifyClaimFailure(new ClaimHttpError(s, "x"))).toBe("rejected");
  });
  it("keeps the server's message", () => {
    expect(new ClaimHttpError(409, "edge node is in use").message).toBe("edge node is in use");
  });
});

describe("nextBackoffMs", () => {
  it("doubles from 5 s up to 60 s", () => {
    expect([0, 1, 2, 3, 4, 5, 20].map(nextBackoffMs)).toEqual([5000, 10000, 20000, 40000, 60000, 60000, 60000]);
  });
});

describe("sameChannels", () => {
  const a = [{ machineId: "m", signalSource: "s7", connectionConfig: { ip: "1", port: 102 } }];
  it("ignores key order", () => {
    expect(sameChannels(a, [{ connectionConfig: { port: 102, ip: "1" }, signalSource: "s7", machineId: "m" }])).toBe(true);
  });
  it("sees changed values and changed list order", () => {
    expect(sameChannels(a, [{ ...a[0]!, connectionConfig: { ip: "2", port: 102 } }])).toBe(false);
    const b = { machineId: "n", signalSource: "s7" };
    expect(sameChannels([a[0], b], [b, a[0]])).toBe(false);
    expect(sameChannels(a, [])).toBe(false);
  });
});

describe("startBackgroundClaim", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const unreachable = () => new TypeError("fetch failed");

  it("keeps retrying with backoff while unreachable and adopts the claim when it succeeds", async () => {
    const claim = vi.fn().mockRejectedValueOnce(unreachable()).mockRejectedValueOnce(unreachable()).mockResolvedValueOnce("ok");
    const onClaimed = vi.fn();
    const onGiveUp = vi.fn();
    const delays: number[] = [];
    startBackgroundClaim({ claim, onClaimed, onGiveUp, onAttemptFailed: (_k, _e, d) => delays.push(d) });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(claim).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(claim).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(claim).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(claim).toHaveBeenCalledTimes(3);
    expect(onClaimed).toHaveBeenCalledWith("ok");
    expect(delays).toEqual([10_000, 20_000]);
    expect(onGiveUp).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(600_000);
    expect(claim).toHaveBeenCalledTimes(3); // done: no more attempts
  });

  it("never gives up while the backend is merely unreachable", async () => {
    const claim = vi.fn().mockRejectedValue(unreachable());
    const onGiveUp = vi.fn();
    startBackgroundClaim({ claim, onClaimed: vi.fn(), onGiveUp });
    await vi.advanceTimersByTimeAsync(24 * 3600_000);
    expect(claim.mock.calls.length).toBeGreaterThan(1000 / 10);
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  it("tolerates a rejection shorter than the grace period (stale lease of a crashed self)", async () => {
    const claim = vi
      .fn()
      .mockRejectedValueOnce(new ClaimHttpError(409, "in use"))
      .mockRejectedValueOnce(new ClaimHttpError(409, "in use"))
      .mockResolvedValue("ok");
    const onClaimed = vi.fn();
    const onGiveUp = vi.fn();
    startBackgroundClaim({ claim, onClaimed, onGiveUp });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onClaimed).toHaveBeenCalledWith("ok");
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  it("gives up once the server has kept rejecting for the grace period", async () => {
    const claim = vi.fn().mockRejectedValue(new ClaimHttpError(409, "edge node is in use"));
    const onGiveUp = vi.fn();
    startBackgroundClaim({ claim, onClaimed: vi.fn(), onGiveUp });
    await vi.advanceTimersByTimeAsync(REJECTION_GRACE_MS - 1_000);
    expect(onGiveUp).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    expect(onGiveUp.mock.calls[0]![0]).toContain("edge node is in use");
    const calls = claim.mock.calls.length;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(claim.mock.calls.length).toBe(calls); // stopped after giving up
  });

  it("rejections are counted from the first one, not from the last", async () => {
    let t = 0;
    const claim = vi.fn().mockRejectedValue(new ClaimHttpError(403, "revoked"));
    const onGiveUp = vi.fn();
    startBackgroundClaim({ claim, onClaimed: vi.fn(), onGiveUp, now: () => t, rejectionGraceMs: 100 });
    t = 0;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onGiveUp).not.toHaveBeenCalled();
    t = 100;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
  });

  it("gives up if adopting the claimed configuration throws", async () => {
    const onGiveUp = vi.fn();
    startBackgroundClaim({
      claim: async () => "ok",
      onClaimed: () => {
        throw new Error("boom");
      },
      onGiveUp,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onGiveUp).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });

  it("stop() cancels pending attempts and ignores an in-flight result", async () => {
    const claim = vi.fn().mockRejectedValue(unreachable());
    const handle = startBackgroundClaim({ claim, onClaimed: vi.fn(), onGiveUp: vi.fn() });
    handle.stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(claim).not.toHaveBeenCalled();

    let resolve!: (v: string) => void;
    const slow = vi.fn(() => new Promise<string>((r) => (resolve = r)));
    const onClaimed = vi.fn();
    const h2 = startBackgroundClaim({ claim: slow, onClaimed, onGiveUp: vi.fn() });
    await vi.advanceTimersByTimeAsync(5_000);
    h2.stop();
    resolve("late");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onClaimed).not.toHaveBeenCalled();
  });
});

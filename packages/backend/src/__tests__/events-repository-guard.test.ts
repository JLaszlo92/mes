import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db.js", () => ({ pool: { query } }));

import { insertEvent } from "../events-repository.js";

const NOW = Date.parse("2026-10-05T19:00:00.000Z");
const ev = (timestamp: string) => ({ machineId: "m1", type: "status_change", timestamp, sourceEventId: "s1", status: "running" }) as never;

describe("insertEvent timestamp guard", () => {
  beforeEach(() => query.mockReset());

  it("stores a normal event unchanged", async () => {
    query.mockResolvedValueOnce({});
    const onCorrected = vi.fn();
    expect(await insertEvent(ev("2026-10-05T18:59:50.000Z"), onCorrected, NOW)).toBe("inserted");
    const params = query.mock.calls[0]![1] as unknown[];
    expect(params[3]).toBe("2026-10-05T18:59:50.000Z");
    expect(JSON.parse(params[5] as string).timestampCorrected).toBeUndefined();
    expect(onCorrected).not.toHaveBeenCalled();
  });

  it("stores a future event with the receive time, marks it and reports it", async () => {
    query.mockResolvedValueOnce({});
    const onCorrected = vi.fn();
    await insertEvent(ev("2026-10-05T19:10:00.000Z"), onCorrected, NOW);
    const params = query.mock.calls[0]![1] as unknown[];
    expect(params[3]).toBe("2026-10-05T19:00:00.000Z");
    const payload = JSON.parse(params[5] as string);
    expect(payload.timestamp).toBe("2026-10-05T19:00:00.000Z");
    expect(payload.timestampCorrected).toEqual({ originalTimestamp: "2026-10-05T19:10:00.000Z", aheadMs: 600_000, reason: "future" });
    expect(payload.status).toBe("running");
    expect(onCorrected).toHaveBeenCalledWith({ originalTimestamp: "2026-10-05T19:10:00.000Z", aheadMs: 600_000, reason: "future" });
  });

  it("does not report a correction for a duplicate", async () => {
    query.mockRejectedValueOnce({ code: "23505" });
    const onCorrected = vi.fn();
    expect(await insertEvent(ev("2026-10-05T19:10:00.000Z"), onCorrected, NOW)).toBe("duplicate");
    expect(onCorrected).not.toHaveBeenCalled();
  });
});

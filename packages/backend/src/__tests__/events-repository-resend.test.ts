import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db.js", () => ({ pool: { query } }));

import { insertEvent } from "../events-repository.js";

const NOW = Date.parse("2026-10-08T10:00:00.000Z");
const ev = (timestamp: string) => ({ machineId: "m1", type: "machine_status", timestamp, sourceEventId: "s1", status: "running" }) as never;

// The event stamped in the future is stored with the receive time, so a resend carries a different
// timestamp than the stored row and the unique index (source_event_id, timestamp) cannot see it.
// The statement therefore also checks, and fills, event_timestamp_corrections (one statement, atomic).
describe("insertEvent resend of an event that was stamped in the future", () => {
  beforeEach(() => query.mockReset());

  it("is one statement that skips an id listed in event_timestamp_corrections", async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });
    await insertEvent(ev("2026-10-08T09:59:50.000Z"), undefined, NOW);
    expect(query).toHaveBeenCalledTimes(1);
    const sql = String(query.mock.calls[0]![0]);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM event_timestamp_corrections WHERE source_event_id = \$5::text\)/);
    expect(sql).toContain("ON CONFLICT DO NOTHING");
  });

  it("marks the id as corrected in the same statement only for a corrected event", async () => {
    query.mockResolvedValue({ rowCount: 1 });
    await insertEvent(ev("2026-10-08T09:59:50.000Z"), undefined, NOW);
    await insertEvent(ev("2026-10-08T10:10:00.000Z"), undefined, NOW);
    expect(String(query.mock.calls[0]![0])).toContain("INSERT INTO event_timestamp_corrections");
    expect((query.mock.calls[0]![1] as unknown[])[6]).toBe(false);
    expect((query.mock.calls[1]![1] as unknown[])[6]).toBe(true);
  });

  it("keeps the positions of the existing parameters", async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });
    await insertEvent(ev("2026-10-08T10:10:00.000Z"), undefined, NOW);
    const params = query.mock.calls[0]![1] as unknown[];
    expect(params).toHaveLength(7);
    expect(params[1]).toBe("m1");
    expect(params[2]).toBe("machine_status");
    expect(params[3]).toBe("2026-10-08T10:00:00.000Z");
    expect(params[4]).toBe("s1");
  });

  it("reports a resend (no row written) as a duplicate and does not report a correction", async () => {
    query.mockResolvedValueOnce({ rowCount: 0 });
    const onCorrected = vi.fn();
    expect(await insertEvent(ev("2026-10-08T10:10:00.000Z"), onCorrected, NOW)).toBe("duplicate");
    expect(onCorrected).not.toHaveBeenCalled();
  });

  it("reports the correction once, for the row that was written", async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });
    const onCorrected = vi.fn();
    expect(await insertEvent(ev("2026-10-08T10:10:00.000Z"), onCorrected, NOW)).toBe("inserted");
    expect(onCorrected).toHaveBeenCalledTimes(1);
  });
});

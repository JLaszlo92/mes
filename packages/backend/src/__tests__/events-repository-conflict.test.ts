import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MachineEvent } from "@mes/shared";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db.js", () => ({ pool: { query } }));

import { insertEvent } from "../events-repository.js";

const NOW = Date.parse("2026-10-07T13:00:00.000Z");
const ev = (): MachineEvent => ({ machineId: "m1", timestamp: "2026-10-07T12:59:50.000Z", sourceEventId: "e1", type: "machine_status", status: "running" }) as unknown as MachineEvent;

describe("insertEvent de-duplication without an exception", () => {
  beforeEach(() => query.mockReset());

  it("asks the database to skip a conflicting row", async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });
    await insertEvent(ev(), undefined, NOW);
    expect(String(query.mock.calls[0]![0])).toContain("ON CONFLICT DO NOTHING");
  });

  it("returns inserted when a row was written", async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });
    expect(await insertEvent(ev(), undefined, NOW)).toBe("inserted");
  });

  it("returns duplicate when the database skipped the row (rowCount 0)", async () => {
    query.mockResolvedValueOnce({ rowCount: 0 });
    expect(await insertEvent(ev(), undefined, NOW)).toBe("duplicate");
  });

  it("still treats a unique violation error as a duplicate", async () => {
    query.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "23505" }));
    expect(await insertEvent(ev(), undefined, NOW)).toBe("duplicate");
  });

  it("does not report a timestamp correction for a skipped row", async () => {
    query.mockResolvedValueOnce({ rowCount: 0 });
    const onCorrected = vi.fn();
    const future = { ...ev(), timestamp: "2026-10-07T13:10:00.000Z" } as MachineEvent;
    expect(await insertEvent(future, onCorrected, NOW)).toBe("duplicate");
    expect(onCorrected).not.toHaveBeenCalled();
  });
});

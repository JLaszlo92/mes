import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db.js", () => ({ pool: { query } }));

import { recordHeartbeat } from "../edge-nodes-repository.js";

describe("heartbeat answer", () => {
  beforeEach(() => {
    query.mockReset();
  });

  it("carries the config revision and the restart request, and does not query channels until asked", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: "n1", current_session_id: "s1", settings: {}, restart_requested_at: "2026-10-08T20:00:00.000Z" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const beat = await recordHeartbeat("token", "s1");
    expect(query).toHaveBeenCalledTimes(2);
    expect(beat.restartRequested).toBe(true);
    const answer = await beat.answer();
    expect(answer.restartRequested).toBe(true);
    expect(answer.configRevision).toMatch(/^[0-9a-f]{16}$/);
  });

  it("reports no restart request when none is pending", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: "n1", current_session_id: "s1", settings: {}, restart_requested_at: null }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const beat = await recordHeartbeat("token", "s1");
    expect((await beat.answer()).restartRequested).toBe(false);
  });
});

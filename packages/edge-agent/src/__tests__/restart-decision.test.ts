import { describe, expect, it } from "vitest";
import { MIN_UPTIME_FOR_REQUEST_MS, MIN_UPTIME_FOR_REVISION_MS, RESTART_EXIT_CODE, RestartDecider } from "../restart-decision.js";

function decider(startUptimeMs = 0) {
  let t = 1_000_000;
  const d = new RestartDecider(() => t, t - startUptimeMs);
  return { d, advance: (ms: number) => (t += ms) };
}
const hb = (configRevision: string | null, restartRequested = false) => ({ configRevision, restartRequested });

describe("RestartDecider", () => {
  it("uses an exit code the unit restarts on (not 0, not 78)", () => {
    expect(RESTART_EXIT_CODE).toBe(75);
  });

  it("does nothing while the revision is the claimed one", () => {
    const { d } = decider(10 * 60_000);
    expect(d.decide("r1", hb("r1"))).toBeNull();
    expect(d.decide("r1", hb("r1"))).toBeNull();
  });

  it("restarts on a request from the dashboard", () => {
    const { d } = decider(5 * 60_000);
    expect(d.decide("r1", hb("r1", true))).toMatch(/requested/);
  });

  it("ignores a request in the first seconds of a start (no loop if the flag were not cleared)", () => {
    const { d, advance } = decider(0);
    expect(d.decide("r1", hb("r1", true))).toBeNull();
    advance(MIN_UPTIME_FOR_REQUEST_MS);
    expect(d.decide("r1", hb("r1", true))).not.toBeNull();
  });

  it("restarts for a changed revision only when it is seen twice in a row", () => {
    const { d, advance } = decider(10 * 60_000);
    expect(d.decide("r1", hb("r2"))).toBeNull(); // first sighting
    advance(30_000);
    expect(d.decide("r1", hb("r2"))).toMatch(/configuration/); // confirmed
  });

  it("restarts once for several edits in a row (the revision keeps changing)", () => {
    const { d, advance } = decider(10 * 60_000);
    expect(d.decide("r1", hb("r2"))).toBeNull();
    advance(30_000);
    expect(d.decide("r1", hb("r3"))).toBeNull(); // changed again: the count starts over
    advance(30_000);
    expect(d.decide("r1", hb("r3"))).not.toBeNull();
  });

  it("forgets a change that was undone", () => {
    const { d, advance } = decider(10 * 60_000);
    expect(d.decide("r1", hb("r2"))).toBeNull();
    advance(30_000);
    expect(d.decide("r1", hb("r1"))).toBeNull(); // back to the claimed one
    advance(30_000);
    expect(d.decide("r1", hb("r2"))).toBeNull(); // starts over, not confirmed yet
  });

  it("does not restart a young process for a revision change", () => {
    const { d, advance } = decider(0);
    expect(d.decide("r1", hb("r2"))).toBeNull();
    advance(30_000);
    expect(d.decide("r1", hb("r2"))).toBeNull(); // uptime 30 s < 60 s
    advance(MIN_UPTIME_FOR_REVISION_MS);
    expect(d.decide("r1", hb("r2"))).not.toBeNull();
  });

  it("does nothing when the agent or the backend does not know a revision (offline start, older backend)", () => {
    const { d, advance } = decider(10 * 60_000);
    expect(d.decide(null, hb("r2"))).toBeNull();
    expect(d.decide("r1", hb(null))).toBeNull();
    advance(60_000);
    expect(d.decide(null, hb("r2"))).toBeNull();
    expect(d.decide("r1", hb(null))).toBeNull();
  });
});

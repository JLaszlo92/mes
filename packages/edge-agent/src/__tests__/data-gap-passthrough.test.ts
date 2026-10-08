import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductionGate } from "../signal-sources/ProductionGate.js";
import { SignalPresenceWatchdog } from "../signal-sources/SignalPresenceWatchdog.js";
import type { SignalReading, SignalSource } from "../signal-sources/SignalSource.js";

const gap: SignalReading = { kind: "data_gap", reason: "too_old", gapSeconds: 900, lostGood: 12, lostScrap: 1 };

function fakeSource() {
  let push: (r: SignalReading) => void = () => {};
  const source: SignalSource = { name: "fake", start: (cb) => { push = cb; }, stop: () => {} };
  return { source, emit: (r: SignalReading) => push(r) };
}

afterEach(() => vi.useRealTimers());

describe("a data_gap reading is never filtered", () => {
  it("passes ProductionGate even while the machine is down and production is not accepted", () => {
    const { source, emit } = fakeSource();
    const out: SignalReading[] = [];
    new ProductionGate(source, false).start((r) => out.push(r));
    emit({ kind: "machine_status", status: "down" });
    emit({ kind: "production_count", result: "good" }); // dropped by the gate
    emit(gap);
    expect(out).toEqual([{ kind: "machine_status", status: "down" }, gap]);
  });

  it("passes SignalPresenceWatchdog without starting the machine or arming it", () => {
    vi.useFakeTimers();
    const { source, emit } = fakeSource();
    const out: SignalReading[] = [];
    const watchdog = new SignalPresenceWatchdog(source, 60_000);
    watchdog.start((r) => out.push(r));
    out.length = 0; // the initial "down"
    emit(gap);
    expect(out).toEqual([gap]); // no synthetic "running"
    watchdog.stop();
  });
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessBridgeSignalSource } from "../signal-sources/ProcessBridgeSignalSource.js";
import type { SignalReading } from "../signal-sources/SignalSource.js";

// A "bridge" that is a small node script printing the given lines, like s7_bridge.py prints JSON lines.
function runBridge(lines: string[]): Promise<SignalReading[]> {
  const dir = mkdtempSync(join(tmpdir(), "bridge-"));
  const script = join(dir, "bridge.js");
  writeFileSync(script, `${lines.map((l) => `console.log(${JSON.stringify(l)});`).join("\n")}\nsetInterval(() => {}, 1000);\n`);
  const source = new ProcessBridgeSignalSource({ name: "t", pythonPath: process.execPath, scriptPath: script });
  const readings: SignalReading[] = [];
  return new Promise((resolve) => {
    source.start((r) => {
      readings.push(r);
      if (r.kind === "production_count") {
        source.stop();
        rmSync(dir, { recursive: true, force: true });
        resolve(readings);
      }
    });
  });
}

afterEach(() => vi.restoreAllMocks());

describe("ProcessBridgeSignalSource and data_gap lines", () => {
  it("passes a valid data_gap line on, and drops malformed ones", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const readings = await runBridge([
      JSON.stringify({ kind: "data_gap", reason: "too_old", gapSeconds: 1200, lostGood: 35, lostScrap: 1 }),
      JSON.stringify({ kind: "data_gap", reason: "clock_back", gapSeconds: null, lostGood: 2, lostScrap: 0 }),
      JSON.stringify({ kind: "data_gap", reason: "too_old", gapSeconds: 1, lostGood: -1, lostScrap: 0 }), // negative
      JSON.stringify({ kind: "data_gap", reason: "", gapSeconds: 1, lostGood: 1, lostScrap: 0 }), // no reason
      JSON.stringify({ kind: "data_gap", reason: "too_old", gapSeconds: 1.5, lostGood: 1, lostScrap: 0 }), // fractional
      JSON.stringify({ kind: "data_gap", reason: "too_old", gapSeconds: 1, lostGood: "7", lostScrap: 0 }), // text
      JSON.stringify({ kind: "production_count", result: "good" }),
    ]);
    expect(readings.filter((r) => r.kind === "data_gap")).toEqual([
      { kind: "data_gap", reason: "too_old", gapSeconds: 1200, lostGood: 35, lostScrap: 1 },
      { kind: "data_gap", reason: "clock_back", gapSeconds: null, lostGood: 2, lostScrap: 0 },
    ]);
  });
});

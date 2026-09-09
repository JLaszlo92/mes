import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { S7SignalSource } from "../signal-sources/S7SignalSource.js";
import type { SignalReading } from "../signal-sources/SignalSource.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Same fixture used by gpio-signal-source.test.ts — it just prints
// newline-JSON SignalReadings, which is the whole wire contract both
// ProcessBridgeSignalSource subclasses share. A separate S7-flavored
// fixture would only duplicate this one.
const FIXTURE_PATH = path.join(__dirname, "fixtures", "fake-gpio-bridge.js");

describe("S7SignalSource", () => {
  it("parses valid JSON lines from the bridge process and drops malformed/unrecognized ones", async () => {
    const readings: SignalReading[] = [];
    const source = new S7SignalSource({ pythonPath: "node", scriptPath: FIXTURE_PATH });

    await new Promise<void>((resolve) => {
      source.start((reading) => {
        readings.push(reading);
      });
      setTimeout(resolve, 400);
    });
    source.stop();

    expect(readings).toEqual([
      { kind: "machine_status", status: "running" },
      { kind: "production_count", result: "good" },
      { kind: "production_count", result: "scrap" },
    ]);
  });

  it("reports itself as the \"s7\" source", () => {
    const source = new S7SignalSource({ scriptPath: FIXTURE_PATH });
    expect(source.name).toBe("s7");
  });
});

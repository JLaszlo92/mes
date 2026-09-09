import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GpioSignalSource } from "../signal-sources/GpioSignalSource.js";
import type { SignalReading } from "../signal-sources/SignalSource.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, "fixtures", "fake-gpio-bridge.js");

describe("GpioSignalSource", () => {
  it("parses valid JSON lines from the bridge process and drops malformed/unrecognized ones", async () => {
    const readings: SignalReading[] = [];
    // "node" stands in for python3 here — the fixture just needs to be
    // something spawnable that prints JSON lines; see the fixture file for
    // why that's a faithful enough stand-in for gpio_bridge.py in this test.
    const source = new GpioSignalSource({ pythonPath: "node", scriptPath: FIXTURE_PATH });

    await new Promise<void>((resolve) => {
      source.start((reading) => {
        readings.push(reading);
      });
      setTimeout(resolve, 400);
    });
    source.stop();

    // Exactly the 3 valid lines the fixture emits — the malformed line and
    // the unknown status value must not produce a reading.
    expect(readings).toEqual([
      { kind: "machine_status", status: "running" },
      { kind: "production_count", result: "good" },
      { kind: "production_count", result: "scrap" },
    ]);
  });
});

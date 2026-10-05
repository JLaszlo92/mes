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

    // The fixture ends with the bridge exiting, which the source reports as "down".
    // Wait for that, not for a fixed delay: a loaded machine starts the process slowly.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5000);
      source.start((reading) => {
        readings.push(reading);
        if (reading.kind === "machine_status" && reading.status === "down") {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    source.stop();

    // The malformed line is dropped. Custom status names are valid since
    // 58b141c, so "bogus_status" passes through, and the bridge exiting
    // makes the source report "down".
    expect(readings).toEqual([
      { kind: "machine_status", status: "running" },
      { kind: "production_count", result: "good" },
      { kind: "production_count", result: "scrap" },
      { kind: "machine_status", status: "bogus_status" },
      { kind: "machine_status", status: "down" },
    ]);
  });
});

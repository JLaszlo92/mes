import { ProcessBridgeSignalSource } from "./ProcessBridgeSignalSource.js";

export interface GpioSignalSourceOptions {
  /** Path to python3 (or a venv's python) — defaults to "python3" on PATH. */
  pythonPath?: string;
  /** Path to gpio_bridge.py. */
  scriptPath: string;
  /** Extra env vars forwarded to the bridge process (GOOD_PIN, etc). */
  env?: Record<string, string>;
}

/**
 * The real, physically-wired counterpart to SimulatedSignalSource: reads a
 * machine's discrete signals via a small Python/gpiozero bridge process
 * (see ../../python/gpio_bridge.py and ../../../docs/pi-test-rig.md)
 * rather than generating them in-process. Everything downstream —
 * buffering, MQTT, retry, the backend, the dashboard — is identical
 * either way, because every SignalSource implementation shares the same
 * interface. Swapping between them is the one-line change in index.ts
 * that PRD Section 5.5 and SignalSource.ts's own docstring promise.
 *
 * If you don't want to deal with physical wiring for a first pass, see
 * S7SignalSource — same interface, same swap point, but talks to a
 * Siemens S7 PLC (or its simulator) over the network instead of GPIO pins.
 */
export class GpioSignalSource extends ProcessBridgeSignalSource {
  constructor(options: GpioSignalSourceOptions) {
    super({ name: "gpio", ...options });
  }
}

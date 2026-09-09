import { ProcessBridgeSignalSource } from "./ProcessBridgeSignalSource.js";

export interface S7SignalSourceOptions {
  /** Path to python3 (or a venv's python) — defaults to "python3" on PATH. */
  pythonPath?: string;
  /** Path to s7_bridge.py. */
  scriptPath: string;
  /** Extra env vars forwarded to the bridge process (PLC_IP, etc). */
  env?: Record<string, string>;
}

/**
 * Reads a Siemens S7 PLC's outputs over the network (S7comm, TCP port
 * 102) via a small Python/python-snap7 bridge process (see
 * ../../python/s7_bridge.py and ../../../docs/pi-test-rig-s7-mode.md),
 * instead of GPIO pins. This is the "no wiring" first pass for the 3-Pi
 * rig: the "machine" Pi runs plc-simulator/plc_simulator.py (an S7 server
 * standing in for a real PLC) and this class's bridge process just needs
 * a network link to it, not physical wires.
 *
 * Same SignalSource contract, same one-line swap in index.ts as
 * GpioSignalSource — the only thing that differs between the two is which
 * bridge script gets spawned and which env vars it needs.
 */
export class S7SignalSource extends ProcessBridgeSignalSource {
  constructor(options: S7SignalSourceOptions) {
    super({ name: "s7", ...options });
  }
}

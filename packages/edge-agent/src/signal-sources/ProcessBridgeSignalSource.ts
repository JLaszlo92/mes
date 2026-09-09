import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { MachineStatusValue } from "@mes/shared";
import type { SignalReading, SignalSource } from "./SignalSource.js";

export interface ProcessBridgeSignalSourceOptions {
  /** Label used in log lines and as `.name` — e.g. "gpio", "s7". */
  name: string;
  /** Path to python3 (or a venv's python) — defaults to "python3" on PATH. */
  pythonPath?: string;
  /** Path to the bridge script to spawn. */
  scriptPath: string;
  /** Extra env vars forwarded to the bridge process. */
  env?: Record<string, string>;
}

const VALID_STATUSES = new Set(MachineStatusValue.options);

/**
 * Shared machinery behind every "spawn a small script, read newline-
 * delimited JSON SignalReadings off its stdout" SignalSource.
 * GpioSignalSource (GPIO pins, edge-triggered pulses) and S7SignalSource
 * (Siemens S7 PLC, polled counters) are both thin wrappers around this —
 * the wire contract (one JSON object per line, matching SignalReading's
 * shape) is what lets either bridge script be swapped in without this
 * class, or anything downstream of it, caring which one is running.
 */
export class ProcessBridgeSignalSource implements SignalSource {
  readonly name: string;

  private child: ChildProcessWithoutNullStreams | null = null;

  constructor(private readonly options: ProcessBridgeSignalSourceOptions) {
    this.name = options.name;
  }

  start(onReading: (reading: SignalReading) => void): void {
    const child = spawn(this.options.pythonPath ?? "python3", [this.options.scriptPath], {
      env: { ...process.env, ...this.options.env },
    });
    this.child = child;

    createInterface({ input: child.stdout }).on("line", (line) => {
      const reading = this.parseLine(line);
      if (reading) onReading(reading);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      console.error(`[${this.name}-bridge] ${chunk.toString("utf-8").trim()}`);
    });

    child.on("exit", (code, signal) => {
      console.error(`[${this.name}-bridge] process exited (code=${code}, signal=${signal})`);
    });

    child.on("error", (err) => {
      console.error(`[${this.name}-bridge] failed to start: ${err.message}`);
    });
  }

  stop(): void {
    this.child?.kill("SIGINT");
    this.child = null;
  }

  private parseLine(line: string): SignalReading | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      console.warn(`[${this.name}-bridge] non-JSON line ignored: ${trimmed}`);
      return null;
    }

    if (typeof parsed !== "object" || parsed === null || !("kind" in parsed)) {
      console.warn(`[${this.name}-bridge] unrecognized line ignored: ${trimmed}`);
      return null;
    }

    const obj = parsed as Record<string, unknown>;

    if (obj.kind === "production_count" && (obj.result === "good" || obj.result === "scrap")) {
      return { kind: "production_count", result: obj.result };
    }

    if (
      obj.kind === "machine_status" &&
      typeof obj.status === "string" &&
      VALID_STATUSES.has(obj.status as MachineStatusValue)
    ) {
      return { kind: "machine_status", status: obj.status as MachineStatusValue };
    }

    console.warn(`[${this.name}-bridge] unrecognized line ignored: ${trimmed}`);
    return null;
  }
}

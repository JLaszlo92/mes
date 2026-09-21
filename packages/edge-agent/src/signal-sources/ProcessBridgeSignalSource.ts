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
const RESPAWN_DELAY_MS = 5000;

/**
 * Shared machinery behind every "spawn a small script, read newline-
 * delimited JSON SignalReadings off its stdout" SignalSource.
 * GpioSignalSource and S7SignalSource are both thin wrappers around this.
 *
 * Resilience note (found during M8 chaos testing): an unexpected bridge
 * process exit — e.g. s7_bridge.py crashing when it loses its PLC
 * connection — used to be silently swallowed: the state store would
 * freeze on the last known status forever, with no indication the
 * machine had actually become unreachable. This class now (a) emits a
 * synthetic "down" reading the moment the bridge process exits
 * unexpectedly, and (b) respawns the bridge after a delay, so the source
 * recovers on its own once the underlying problem clears — the same
 * resilience shape as OpcUaSignalSource/ModbusSignalSource's reconnect
 * logic, just applied to a child process instead of a network client.
 */
export class ProcessBridgeSignalSource implements SignalSource {
  readonly name: string;

  private child: ChildProcessWithoutNullStreams | null = null;
  private stopped = false;
  private reportedDown = false;

  constructor(private readonly options: ProcessBridgeSignalSourceOptions) {
    this.name = options.name;
  }

  start(onReading: (reading: SignalReading) => void): void {
    this.stopped = false;
    this.spawnChild(onReading);
  }

  private spawnChild(onReading: (reading: SignalReading) => void): void {
    const child = spawn(this.options.pythonPath ?? "python3", [this.options.scriptPath], {
      env: { ...process.env, ...this.options.env },
    });
    this.child = child;
    this.reportedDown = false;

    createInterface({ input: child.stdout }).on("line", (line) => {
      const reading = this.parseLine(line);
      if (reading) {
        if (reading.kind === "machine_status") this.reportedDown = reading.status === "down";
        onReading(reading);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      console.error(`[${this.name}-bridge] ${chunk.toString("utf-8").trim()}`);
    });

    child.on("exit", (code, signal) => {
      console.error(`[${this.name}-bridge] process exited (code=${code}, signal=${signal})`);
      this.child = null;
      if (this.stopped) return;

      // A bridge-folyamat váratlan leállása pontosan olyan, mintha a gép
      // elérhetetlenné vált volna — jelöljük "down"-nak explicit, ne
      // fagyjon be csendben az utolsó ismert állapoton.
      if (!this.reportedDown) {
        this.reportedDown = true;
        onReading({ kind: "machine_status", status: "down" });
      }

      // Próbáljunk újraindítani pár másodperc múlva — ha az alapprobléma
      // (pl. a PLC-szimulátor) közben helyreállt, a bridge magától
      // folytatja, emberi beavatkozás nélkül.
      setTimeout(() => {
        if (!this.stopped) this.spawnChild(onReading);
      }, RESPAWN_DELAY_MS);
    });

    child.on("error", (err) => {
      console.error(`[${this.name}-bridge] failed to start: ${err.message}`);
    });
  }

  stop(): void {
    this.stopped = true;
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
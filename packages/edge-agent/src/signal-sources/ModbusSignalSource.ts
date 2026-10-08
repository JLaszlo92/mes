import ModbusRTU from "modbus-serial";
import type { MachineStatusValue } from "@mes/shared";
import type { SignalReading, SignalSource } from "./SignalSource.js";

const STATUS_BY_CODE: Record<number, MachineStatusValue> = {
  0: "idle",
  1: "running",
  2: "down",
  3: "changeover",
};

import type { CounterBaseline } from "../counter-baseline.js";

export interface ModbusSignalSourceOptions {
  host: string;
  port?: number;
  unitId?: number;
  goodCountRegister?: number;
  scrapCountRegister?: number;
  statusRegister?: number;
  pollIntervalMs?: number;
  /** Books parts produced while the agent or the PLC link was down (see counter-baseline.ts). */
  counterBaseline?: CounterBaseline;
}

/**
 * Polls three Modbus holding registers on a fixed interval. Unlike
 * node-opcua (which has a built-in reconnection strategy), modbus-serial
 * does not reconnect automatically when the underlying TCP connection
 * drops (e.g. the simulator/PLC restarts) — so this class handles that
 * itself: any failed poll triggers a reconnect attempt on the next tick,
 * retried indefinitely until it succeeds.
 */
export class ModbusSignalSource implements SignalSource {
  readonly name = "modbus";

  private client = new (ModbusRTU as any)();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastGoodCount: number | null = null;
  private lastScrapCount: number | null = null;
  private lastStatus: number | null = null;
  private connected = false;
  private reconnecting = false;
  private reportedDown = false;

  constructor(private readonly options: ModbusSignalSourceOptions) {}

  start(onReading: (reading: SignalReading) => void): void {
    void this.connectAndPoll(onReading);
  }

  private async connect(): Promise<void> {
    await this.client.connectTCP(this.options.host, { port: this.options.port ?? 502 });
    this.client.setID(this.options.unitId ?? 1);
    this.connected = true;
  }

  private async connectAndPoll(onReading: (reading: SignalReading) => void): Promise<void> {
    await this.connect();
    const pollIntervalMs = this.options.pollIntervalMs ?? 1000;
    this.timer = setInterval(() => void this.poll(onReading), pollIntervalMs);
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.connected = false;
    try {
      this.client.close(() => {});
    } catch {
      // ignore — a kapcsolat már úgyis megszakadt
    }
    try {
      await this.connect();
      console.log("Modbus reconnected");
    } catch (err) {
      console.error("Modbus reconnect failed, will retry on next tick", err);
    } finally {
      this.reconnecting = false;
    }
  }

  private async poll(onReading: (reading: SignalReading) => void): Promise<void> {
    if (!this.connected) {
      void this.reconnect();
      return;
    }
    try {
      this.reportedDown = false;
      const goodAddr = this.options.goodCountRegister ?? 0;
      const scrapAddr = this.options.scrapCountRegister ?? 1;
      const statusAddr = this.options.statusRegister ?? 2;
      const maxAddr = Math.max(goodAddr, scrapAddr, statusAddr);

      const result = await this.client.readHoldingRegisters(0, maxAddr + 1);
      const goodCount = result.data[goodAddr];
      const scrapCount = result.data[scrapAddr];
      const statusCode = result.data[statusAddr];

      if (
        this.options.counterBaseline &&
        this.lastGoodCount === null &&
        this.lastScrapCount === null &&
        typeof goodCount === "number" &&
        typeof scrapCount === "number"
      ) {
        // First reading after a start or a lost connection: book the parts made while not observed.
        const seeded = this.options.counterBaseline.onFirstRead(goodCount, scrapCount);
        const gap = this.options.counterBaseline.takeDroppedGap();
        if (gap) onReading({ kind: "data_gap", ...gap });
        for (let i = 0; i < seeded.good; i++) onReading({ kind: "production_count", result: "good" });
        for (let i = 0; i < seeded.scrap; i++) onReading({ kind: "production_count", result: "scrap" });
      }

      if (typeof goodCount === "number") {
        if (this.lastGoodCount !== null && goodCount > this.lastGoodCount) {
          for (let i = 0; i < goodCount - this.lastGoodCount; i++) {
            onReading({ kind: "production_count", result: "good" });
          }
        }
        this.lastGoodCount = goodCount;
      }

      if (typeof scrapCount === "number") {
        if (this.lastScrapCount !== null && scrapCount > this.lastScrapCount) {
          for (let i = 0; i < scrapCount - this.lastScrapCount; i++) {
            onReading({ kind: "production_count", result: "scrap" });
          }
        }
        this.lastScrapCount = scrapCount;
      }

      if (typeof goodCount === "number" && typeof scrapCount === "number") {
        this.options.counterBaseline?.onRead(goodCount, scrapCount);
      }

      if (typeof statusCode === "number" && statusCode !== this.lastStatus) {
        this.lastStatus = statusCode;
        const status = STATUS_BY_CODE[statusCode];
        if (status) onReading({ kind: "machine_status", status });
      }
    } catch (err) {
      console.error("Modbus poll failed — will reconnect", err);
      if (!this.reportedDown) {
        this.reportedDown = true;
        this.lastStatus = null;
        if (this.options.counterBaseline) {
          // Re-baseline after the connection is back (see CounterBaseline.onFirstRead).
          this.lastGoodCount = null;
          this.lastScrapCount = null;
        }
        onReading({ kind: "machine_status", status: "down" });
      }
      void this.reconnect();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.connected = false;
    this.client.close(() => {});
  }
}
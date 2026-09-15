import ModbusRTU from "modbus-serial";
import type { MachineStatusValue } from "@mes/shared";
import type { SignalReading, SignalSource } from "./SignalSource.js";

const STATUS_BY_CODE: Record<number, MachineStatusValue> = {
  0: "idle",
  1: "running",
  2: "down",
  3: "changeover",
};

export interface ModbusSignalSourceOptions {
  host: string;
  port?: number;
  unitId?: number;
  goodCountRegister?: number;
  scrapCountRegister?: number;
  statusRegister?: number;
  pollIntervalMs?: number;
}

/**
 * Polls three Modbus holding registers on a fixed interval and diffs the
 * two counters against their previous reading — the same poll-and-diff
 * shape as S7SignalSource and OpcUaSignalSource. Modbus registers are
 * plain 16-bit numbers, so the status register carries a numeric code
 * (STATUS_BY_CODE) rather than a string.
 */
export class ModbusSignalSource implements SignalSource {
  readonly name = "modbus";

  private client = new (ModbusRTU as any)();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastGoodCount: number | null = null;
  private lastScrapCount: number | null = null;
  private lastStatus: number | null = null;
  private connected = false;

  constructor(private readonly options: ModbusSignalSourceOptions) {}

  start(onReading: (reading: SignalReading) => void): void {
    void this.connectAndPoll(onReading);
  }

  private async connectAndPoll(onReading: (reading: SignalReading) => void): Promise<void> {
    await this.client.connectTCP(this.options.host, { port: this.options.port ?? 502 });
    this.client.setID(this.options.unitId ?? 1);
    this.connected = true;

    const pollIntervalMs = this.options.pollIntervalMs ?? 1000;
    this.timer = setInterval(() => void this.poll(onReading), pollIntervalMs);
  }

  private async poll(onReading: (reading: SignalReading) => void): Promise<void> {
    if (!this.connected) return;
    try {
      const goodAddr = this.options.goodCountRegister ?? 0;
      const scrapAddr = this.options.scrapCountRegister ?? 1;
      const statusAddr = this.options.statusRegister ?? 2;
      const maxAddr = Math.max(goodAddr, scrapAddr, statusAddr);

      const result = await this.client.readHoldingRegisters(0, maxAddr + 1);
      const goodCount = result.data[goodAddr];
      const scrapCount = result.data[scrapAddr];
      const statusCode = result.data[statusAddr];

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

      if (typeof statusCode === "number" && statusCode !== this.lastStatus) {
        this.lastStatus = statusCode;
        const status = STATUS_BY_CODE[statusCode];
        if (status) onReading({ kind: "machine_status", status });
      }
    } catch (err) {
      console.error("Modbus poll failed", err);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.connected = false;
    this.client.close(() => {});
  }
}
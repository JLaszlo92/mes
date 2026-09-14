import { OPCUAClient, MessageSecurityMode, SecurityPolicy, AttributeIds, ClientSession } from "node-opcua";
import type { MachineStatusValue } from "@mes/shared";
import type { SignalReading, SignalSource } from "./SignalSource.js";

export interface OpcUaSignalSourceOptions {
  endpointUrl: string;
  goodCountNodeId: string;
  scrapCountNodeId: string;
  statusNodeId: string;
  pollIntervalMs?: number;
}

/**
 * Polls three OPC-UA nodes on a fixed interval and diffs the two counters
 * against their previous reading — the same poll-and-diff shape as
 * S7SignalSource (see DEVELOPMENT_STATUS.md): a counter increase of N
 * becomes N discrete production_count readings, and the status node is
 * reported whenever it changes.
 *
 * Unlike GpioSignalSource/S7SignalSource, this talks to the network
 * directly via node-opcua — no Python bridge process, because node-opcua
 * is a mature native Node client (ROADMAP.md Section 3's stack rationale).
 */
export class OpcUaSignalSource implements SignalSource {
  readonly name = "opcua";

  private client: OPCUAClient | null = null;
  private session: ClientSession | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastGoodCount: number | null = null;
  private lastScrapCount: number | null = null;
  private lastStatus: string | null = null;

  constructor(private readonly options: OpcUaSignalSourceOptions) {}

  start(onReading: (reading: SignalReading) => void): void {
    void this.connectAndPoll(onReading);
  }

  private async connectAndPoll(onReading: (reading: SignalReading) => void): Promise<void> {
    const client = OPCUAClient.create({
      endpointMustExist: false,
      securityMode: MessageSecurityMode.None,
      securityPolicy: SecurityPolicy.None,
      // node-opcua reconnects the underlying connection itself; our own
      // buffer+retry layer in index.ts is what guarantees no data loss
      // even through a longer outage than that alone covers.
      connectionStrategy: { maxRetry: -1, initialDelay: 1000, maxDelay: 5000 },
    });
    this.client = client;

    await client.connect(this.options.endpointUrl);
    this.session = await client.createSession();

    const pollIntervalMs = this.options.pollIntervalMs ?? 1000;
    this.timer = setInterval(() => void this.poll(onReading), pollIntervalMs);
  }

  private async poll(onReading: (reading: SignalReading) => void): Promise<void> {
    if (!this.session) return;
    try {
      const results = await this.session.read([
        { nodeId: this.options.goodCountNodeId, attributeId: AttributeIds.Value },
        { nodeId: this.options.scrapCountNodeId, attributeId: AttributeIds.Value },
        { nodeId: this.options.statusNodeId, attributeId: AttributeIds.Value },
      ]);

      const goodCount = results[0]?.value?.value as number | undefined;
      const scrapCount = results[1]?.value?.value as number | undefined;
      const status = results[2]?.value?.value as string | undefined;

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

      if (typeof status === "string" && status !== this.lastStatus) {
        this.lastStatus = status;
        onReading({ kind: "machine_status", status: status as MachineStatusValue });
      }
    } catch (err) {
      // Egy sikertelen poll (pl. rövid hálózati akadás) nem végzetes — a
      // node-opcua saját maga próbál újracsatlakozni, a következő tick
      // egyszerűen újra próbálkozik.
      console.error("OPC-UA poll failed", err);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    void this.session?.close();
    void this.client?.disconnect();
  }
}
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

const READ_TIMEOUT_MS = 3000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Polls three OPC-UA nodes on a fixed interval and diffs the two counters
 * against their previous reading — the same poll-and-diff shape as
 * S7SignalSource. Unlike GpioSignalSource/S7SignalSource, this talks to
 * the network directly via node-opcua — no Python bridge process.
 *
 * Resilience note (found during M8 chaos testing): when the server
 * becomes unreachable, node-opcua's session.read() does NOT reject — it
 * just queues the request and waits indefinitely for the connection to
 * come back, while node-opcua's own reconnection logic works in the
 * background. Combined with our setInterval firing every tick regardless,
 * this silently piled up an ever-growing stack of pending ReadRequests
 * (visible as node-opcua's own "sending multiple requests simultaneously"
 * warning) and — worse — never told the rest of the system the machine
 * had become unreachable, so the dashboard just froze on the last known
 * status. Fixed with two changes: (1) a `pollInFlight` guard so a new
 * read is never started while a previous one is still outstanding, and
 * (2) wrapping the read in a timeout, so a stuck read is treated as a
 * failure — surfaced as a "down" status — after a few seconds, rather
 * than hanging forever.
 */
export class OpcUaSignalSource implements SignalSource {
  readonly name = "opcua";

  private client: OPCUAClient | null = null;
  private session: ClientSession | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastGoodCount: number | null = null;
  private lastScrapCount: number | null = null;
  private lastStatus: string | null = null;
  private reportedDown = false;
  private pollInFlight = false;

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
    if (!this.session || this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      const results = await withTimeout(
        this.session.read([
          { nodeId: this.options.goodCountNodeId, attributeId: AttributeIds.Value },
          { nodeId: this.options.scrapCountNodeId, attributeId: AttributeIds.Value },
          { nodeId: this.options.statusNodeId, attributeId: AttributeIds.Value },
        ]),
        READ_TIMEOUT_MS,
        "OPC-UA read",
      );

      this.reportedDown = false;

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
      console.error("OPC-UA poll failed", err);
      if (!this.reportedDown) {
        this.reportedDown = true;
        this.lastStatus = null;
        onReading({ kind: "machine_status", status: "down" });
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    void this.session?.close();
    void this.client?.disconnect();
  }
}
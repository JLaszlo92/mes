import type { MachineStatusValue } from "@mes/shared";

/**
 * What a signal source hands to the agent core — deliberately missing
 * machineId/timestamp/sourceEventId, which the core (index.ts) stamps on
 * uniformly for every source, so an implementation only has to know about
 * the signal it's reading, not the envelope around it.
 */
export type SignalReading =
  | { kind: "production_count"; result: "good" | "scrap"; scrapReasonCode?: string }
  | { kind: "machine_status"; status: MachineStatusValue };

/**
 * The extension point PRD Section 5.5 describes: today this interface has
 * one implementation (SimulatedSignalSource). Swapping in a real machine
 * connection later — a discrete digital-I/O module wired to a good/scrap
 * pulse and a light-stack contact, or an OPC-UA/Modbus tag read — means
 * writing one new class here and changing one line in index.ts. Nothing
 * downstream (buffering, MQTT publish, the backend, the dashboard) needs to
 * know or care which kind of source it was.
 */
export interface SignalSource {
  readonly name: string;
  start(onReading: (reading: SignalReading) => void): void;
  stop(): void;
}

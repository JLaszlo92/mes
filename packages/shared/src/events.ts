import { z } from "zod";

/**
 * The structured event model referenced in PRD Section 7: a small, fixed set
 * of event types flows from edge to cloud, rather than raw signal firehoses.
 * Both the edge agent and the backend import this file so a change to the
 * contract is a compile error in both places, not a silent mismatch.
 *
 * M0/M1 scope: production counting + machine status only, per ROADMAP.md
 * milestones M1-M2. Later milestones (quality checks, maintenance events,
 * genealogy) add new variants to MachineEventSchema below — existing
 * producers/consumers are unaffected because each variant is discriminated
 * by `type` and handled independently.
 */

export const MachineStatusValue = z.enum(["running", "idle", "down", "changeover"]);
export type MachineStatusValue = z.infer<typeof MachineStatusValue>;

const baseEventFields = {
  machineId: z.string().min(1),
  // ISO 8601 timestamp set by the edge agent at the moment of capture, not
  // when it happens to reach the cloud — this matters once events are
  // buffered locally and can arrive minutes or hours late.
  timestamp: z.string().datetime(),
  // A stable id assigned at the edge (see edge-agent/src/buffer.ts). Lets the
  // backend de-duplicate safely if a buffered batch is retried after a
  // partial failure.
  sourceEventId: z.string().min(1),
};

export const ProductionCountEventSchema = z.object({
  ...baseEventFields,
  type: z.literal("production_count"),
  result: z.enum(["good", "scrap"]),
  scrapReasonCode: z.string().optional(),
  jobId: z.string().optional(),
});
export type ProductionCountEvent = z.infer<typeof ProductionCountEventSchema>;

export const MachineStatusEventSchema = z.object({
  ...baseEventFields,
  type: z.literal("machine_status"),
  status: MachineStatusValue,
});
export type MachineStatusEvent = z.infer<typeof MachineStatusEventSchema>;

export const MachineEventSchema = z.discriminatedUnion("type", [
  ProductionCountEventSchema,
  MachineStatusEventSchema,
]);
export type MachineEvent = z.infer<typeof MachineEventSchema>;

export function parseMachineEvent(raw: unknown): MachineEvent {
  return MachineEventSchema.parse(raw);
}

export function safeParseMachineEvent(raw: unknown) {
  return MachineEventSchema.safeParse(raw);
}

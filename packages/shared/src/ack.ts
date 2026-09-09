import { z } from "zod";

export const AckMessageSchema = z.object({
  sourceEventId: z.string().min(1),
});
export type AckMessage = z.infer<typeof AckMessageSchema>;

export function safeParseAck(raw: unknown) {
  return AckMessageSchema.safeParse(raw);
}

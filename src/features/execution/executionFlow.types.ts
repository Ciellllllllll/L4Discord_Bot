import { z } from "zod";

export const executionPhaseSchema = z.enum([
  "poll1_pending",
  "poll2_pending",
  "admin_pending",
  "completed",
  "cancelled",
]);

export type ExecutionPhase = z.infer<typeof executionPhaseSchema>;

export const executionActionSchema = z.enum(["timeout", "kick", "ban"]);

export type ExecutionAction = z.infer<typeof executionActionSchema>;

export const executionFlowStateSchema = z.object({
  phase: executionPhaseSchema,
  invoker_id: z.string(),
  target_id: z.string(),
  channel_id: z.string(),
  poll1_message_id: z.string(),
  poll2_message_id: z.string().nullable(),
  admin_message_id: z.string().nullable(),
  resolved_action: executionActionSchema.nullable(),
  duration_ms: z.number().nullable(),
  admin_button_fired: z.boolean(),
});

export type ExecutionFlowState = z.infer<typeof executionFlowStateSchema>;

export function parseExecutionFlowState(raw: unknown): ExecutionFlowState | null {
  const r = executionFlowStateSchema.safeParse(raw);
  return r.success ? r.data : null;
}

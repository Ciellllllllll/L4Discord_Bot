import { z } from "zod";

const tePhaseSchema = z.enum(["poll1_pending", "poll2_pending", "admin_pending", "completed", "cancelled"]);

const poll1Vote = z.enum(["extend", "release"]);
const poll2Vote = z.enum(["s3600", "s86400", "s604800"]);

export const timeoutExtendFlowStateSchema = z.object({
  phase: tePhaseSchema,
  invoker_id: z.string(),
  target_id: z.string(),
  /** 投票・承認メッセージを送るチャンネル */
  channel_id: z.string(),
  poll1_message_id: z.string().nullable(),
  /** Discord投稿前にCASで取得する第1投票メッセージの送信予約 */
  poll1_publish_reserved: z.boolean().optional(),
  poll2_message_id: z.string().nullable(),
  admin_message_id: z.string().nullable(),
  votes_poll1: z.record(z.string(), poll1Vote),
  votes_poll2: z.record(z.string(), poll2Vote),
  poll1_deadline_ms: z.number(),
  poll2_deadline_ms: z.number().nullable(),
  resolved_extend: z.enum(["extend", "release"]).nullable(),
  duration_seconds: z.number().nullable(),
  admin_button_fired: z.boolean(),
});

export type TimeoutExtendFlowState = z.infer<typeof timeoutExtendFlowStateSchema>;

export function parseTimeoutExtendFlowState(raw: unknown): TimeoutExtendFlowState | null {
  const r = timeoutExtendFlowStateSchema.safeParse(raw);
  return r.success ? r.data : null;
}

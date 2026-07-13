import { z } from "zod";

export const executionPhaseSchema = z.enum([
  "precheck_pending",
  "poll1_pending",
  "poll2_pending",
  "admin_pending",
  "completed",
  "cancelled",
]);

export type ExecutionPhase = z.infer<typeof executionPhaseSchema>;

export const executionActionSchema = z.enum(["timeout", "kick", "ban"]);

export type ExecutionAction = z.infer<typeof executionActionSchema>;

const vote12 = z.enum(["1", "2", "3"]);
const vote1234 = z.enum(["1", "2", "3", "4"]);

export const executionFlowStateSchema = z.object({
  phase: executionPhaseSchema,
  invoker_id: z.string(),
  target_id: z.string(),
  channel_id: z.string(),
  /** 事前承認（EXECUTOR_ROLE_ID）用メッセージ */
  precheck_message_id: z.string().nullable(),
  /** Discord投稿前にCASで取得する事前承認メッセージの送信予約 */
  precheck_publish_reserved: z.boolean().optional(),
  /** 処刑内容投票: 見出し + Embed + ボタンが同一メッセージ。事前承認フェーズでは null */
  poll1_message_id: z.string().nullable(),
  /** タイムアウト時間投票（タイムアウト選択時のみ） */
  poll2_message_id: z.string().nullable(),
  votes_poll1: z.record(z.string(), vote12),
  votes_poll2: z.record(z.string(), vote1234),
  poll1_deadline_ms: z.number(),
  poll2_deadline_ms: z.number().nullable(),
  admin_message_id: z.string().nullable(),
  resolved_action: executionActionSchema.nullable(),
  /** タイムアウト時の秒（poll2 の結果） */
  duration_seconds: z.number().nullable(),
  admin_button_fired: z.boolean(),
});

export type ExecutionFlowState = z.infer<typeof executionFlowStateSchema>;

export function parseExecutionFlowState(raw: unknown): ExecutionFlowState | null {
  const r = executionFlowStateSchema.safeParse(raw);
  return r.success ? r.data : null;
}

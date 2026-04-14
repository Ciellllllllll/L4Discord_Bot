import type { ColumnType, Generated } from "kysely";

export interface GuildSettingsRow {
  guild_id: string;
  data: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>;
  updated_at: Date;
}

export interface InteractionSessionsRow {
  id: string;
  guild_id: string;
  domain: string;
  action: string;
  payload: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>;
  executor_user_id: string | null;
  expires_at: Date;
  created_at: Date;
}

export interface DetecterIncidentsRow {
  id: Generated<string>;
  guild_id: string;
  audit_entry_id: string;
  executor_id: string;
  target_id: string;
  action_type: string;
  reason: string | null;
  appeal_ticket_id: string | null;
  created_at: Date;
}

export interface AuditLogCursorsRow {
  guild_id: string;
  last_snowflake: string;
}

export interface TicketsRow {
  id: Generated<string>;
  guild_id: string;
  kind: string;
  status: string;
  opener_id: string | null;
  assignee_id: string | null;
  data: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>;
  created_at: Date;
  updated_at: Date;
}

export interface AppealsRow {
  id: string;
  code: string;
  guild_id: string;
  user_id: string;
  punishment_type: string;
  punishment_reason: string | null;
  timeout_start: number;
  timeout_end: number;
  status: string;
  appeal_reason: string | null;
  detecter_incident_id: string | null;
  created_at: Date;
  updated_at: Date;
  reviewer_id: string | null;
  review_note: string | null;
  review_message_id: string | null;
}

export interface ModmailThreadsRow {
  id: string;
  guild_id: string;
  user_id: string;
  channel_id: string | null;
  thread_id: string | null;
  status: string;
  data: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>;
  created_at: Date;
}

// Modmail スタッフ返信キュー（!reply → 承認後にユーザーへ DM）

export interface ModmailRepliesRow {
  id: string;
  ticket_id: string;
  guild_id: string;
  user_id: string;
  thread_id: string;
  status: string;
  source_message_id: string;
  confirm_message_id: string | null;
  author_staff_id: string;
  approver_staff_id: string | null;
  content: string | null;
  fixed_reply_body: string;
  attachment_metadata: string;
  created_at: Date;
  updated_at: Date;
  approved_at: Date | null;
  rejected_at: Date | null;
  sent_at: Date | null;
  failed_at: Date | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  failure_reason: string | null;
  close_reason: string | null;
}

export interface ModmailEventsRow {
  id: Generated<number>;
  event_type: string;
  payload: string;
  created_at: Date;
}

// DiscordBOTv2 modmail_intakes 相当（DM 前の受付状態）

export interface ModmailIntakesRow {
  guild_id: string;
  user_id: string;
  status: string;
  requested_at: Date;
  dm_sent_at: Date | null;
  updated_at: Date;
}

export interface WerewolfGamesRow {
  id: Generated<string>;
  guild_id: string;
  channel_id: string;
  host_id: string;
  phase: string;
  state: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>;
  created_at: Date;
  updated_at: Date;
}

export interface EconomyAccountsRow {
  guild_id: string;
  user_id: string;
  balance: bigint;
  xp: bigint;
  updated_at: Date;
}

export interface EconomyLedgerRow {
  id: Generated<bigint>;
  guild_id: string;
  user_id: string;
  delta: bigint;
  reason: string;
  meta: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>;
  created_at: Date;
}

export interface KeywordStatsRow {
  guild_id: string;
  user_id: string;
  keyword_key: string;
  count: bigint;
  updated_at: Date;
}

export interface ReactionRoleMessagesRow {
  id: Generated<string>;
  guild_id: string;
  channel_id: string;
  message_id: string;
  config: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>;
  created_at: Date;
}

// ボタン式リアクションロール（1エントリ = 1公開メッセージ、最大5ロール）

export interface ReactionRoleEntriesRow {
  id: string;
  guild_id: string;
  entry_id: string;
  channel_id: string;
  message_id: string | null;
  title: string;
  description: string;
  roles_json: string;
  created_at: Date;
}

export interface PanelMessagesRow {
  id: Generated<string>;
  guild_id: string;
  panel_kind: string;
  channel_id: string;
  message_id: string;
  data: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>;
  created_at: Date;
}

export interface StampUsageRow {
  guild_id: string;
  user_id: string;
  emoji_id: string;
  emoji_name: string;
  count: bigint;
  updated_at: Date;
}

// 参照 vc_time.db 互換

export interface VcSessionsRow {
  id: Generated<number>;
  guild_id: bigint | number;
  user_id: bigint | number;
  channel_id: bigint | number;
  started_at: string;
  ended_at: string | null;
  duration_sec: number | null;
}

export interface RemindersRow {
  id: string;
  guild_id: string;
  channel_id: string;
  author_id: string;
  body: string;
  fire_at: string;
  status: string;
  data: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>;
  created_at: Date;
}

export interface TodosRow {
  id: string;
  guild_id: string;
  channel_id: string | null;
  author_id: string;
  title: string;
  body: string | null;
  status: string;
  due_at: string | null;
  created_at: Date;
}

export interface AnnouncementsRow {
  id: string;
  guild_id: string;
  channel_id: string;
  author_id: string;
  title: string;
  body: string;
  scheduled_at: string | null;
  posted_at: string | null;
  status: string;
  created_at: Date;
}

export interface VcPanelConfigsRow {
  id: string;
  guild_id: string;
  category_id: string;
  name: string;
  data: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>;
  created_at: Date;
}

export interface AiHistoryRow {
  id: string;
  guild_id: string;
  user_id: string;
  role: string;
  content: string;
  meta: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>;
  created_at: Date;
}

export interface PollsRow {
  id: string;
  guild_id: string;
  channel_id: string;
  message_id: string | null;
  kind: string;
  status: string;
  state: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>;
  ends_at: string | null;
  created_at: Date;
  updated_at: Date;
}

// /q 会話履歴（data/AI_History.db）

export interface AiHistoryDatabase {
  ai_history: AiHistoryRow;
}

// 自動モデレーション設定（data/Automoderation.db）

export interface AutomodGuildSettingsRow {
  guild_id: string;
  data: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>;
  updated_at: Date;
}

export interface AutomoderationDatabase {
  automod_guild_settings: AutomodGuildSettingsRow;
}

// リマインダーハブ専用（既定: data/reminder.db）

export interface ReminderDatabase {
  reminders: RemindersRow;
}

// Modmail / appeals / 汎用 tickets（data/ticket.db）

export interface TicketDatabase {
  tickets: TicketsRow;
  appeals: AppealsRow;
  modmail_threads: ModmailThreadsRow;
  modmail_intakes: ModmailIntakesRow;
  modmail_replies: ModmailRepliesRow;
  modmail_events: ModmailEventsRow;
}

export interface Database {
  guild_settings: GuildSettingsRow;
  interaction_sessions: InteractionSessionsRow;
  detecter_incidents: DetecterIncidentsRow;
  audit_log_cursors: AuditLogCursorsRow;
  werewolf_games: WerewolfGamesRow;
  economy_accounts: EconomyAccountsRow;
  economy_ledger: EconomyLedgerRow;
  keyword_stats: KeywordStatsRow;
  reaction_role_messages: ReactionRoleMessagesRow;
  reaction_role_entries: ReactionRoleEntriesRow;
  panel_messages: PanelMessagesRow;
  stamp_usage: StampUsageRow;
  todos: TodosRow;
  announcements: AnnouncementsRow;
  vc_panel_configs: VcPanelConfigsRow;
  polls: PollsRow;
}

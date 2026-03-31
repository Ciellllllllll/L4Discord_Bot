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

export interface ModmailThreadsRow {
  id: Generated<string>;
  guild_id: string;
  user_id: string;
  channel_id: string | null;
  thread_id: string | null;
  status: string;
  data: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>;
  created_at: Date;
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

/** 参照 message.db 互換（guild/channel/user_id は INTEGER＝Snowflake を BigInt で扱う） */
export interface MessageLogsRow {
  id: Generated<number>;
  log_type: string | null;
  guild_id: bigint | number | null;
  channel_id: bigint | number | null;
  user_id: bigint | number | null;
  user_name: string | null;
  content: string | null;
  edited_at: string | null;
  deleted_at: string | null;
  time: string | null;
  attachments: string | null;
}

/** 参照 vc_time.db 互換 */
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

export interface Database {
  guild_settings: GuildSettingsRow;
  interaction_sessions: InteractionSessionsRow;
  detecter_incidents: DetecterIncidentsRow;
  audit_log_cursors: AuditLogCursorsRow;
  tickets: TicketsRow;
  modmail_threads: ModmailThreadsRow;
  werewolf_games: WerewolfGamesRow;
  economy_accounts: EconomyAccountsRow;
  economy_ledger: EconomyLedgerRow;
  keyword_stats: KeywordStatsRow;
  reaction_role_messages: ReactionRoleMessagesRow;
  panel_messages: PanelMessagesRow;
  stamp_usage: StampUsageRow;
  message_logs: MessageLogsRow;
  sessions: VcSessionsRow;
  reminders: RemindersRow;
  todos: TodosRow;
  announcements: AnnouncementsRow;
  vc_panel_configs: VcPanelConfigsRow;
  ai_history: AiHistoryRow;
  polls: PollsRow;
}

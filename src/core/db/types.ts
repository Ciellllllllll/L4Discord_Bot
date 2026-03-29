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
}

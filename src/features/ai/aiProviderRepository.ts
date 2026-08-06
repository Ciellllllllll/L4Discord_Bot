import type DatabaseLib from "better-sqlite3";
import type { AiProvider, AiRoutePreference } from "./providerTypes.js";

export interface AiProviderSettingsRepository {
  getPreference(guildId: string): Promise<AiRoutePreference>;
  setPreference(guildId: string, preference: AiRoutePreference): Promise<void>;
}

export type AiTokenReservationStatus = "pending" | "settled" | "released";

export type AiUsageSnapshot = {
  orgTargetTokens: number;
  botReportedTokens: number;
};

export type AiTokenReservation = {
  reservationId: string;
  provider: AiProvider;
  usageDate: string;
  reservedTokens: number;
  status: AiTokenReservationStatus;
  actualTokens: number | null;
};

export type AiTokenReservationRequest = {
  reservationId: string;
  provider: AiProvider;
  usageDate: string;
  reservedTokens: number;
  threshold: number;
  snapshot: AiUsageSnapshot;
};

export type AiTokenReservationResult = {
  allowed: boolean;
  duplicate: boolean;
  effectiveTokens: number;
  reason?: "threshold_exceeded" | "reservation_released";
  reservation?: AiTokenReservation;
};

export interface AiProviderBudgetRepository {
  tryReserve(input: AiTokenReservationRequest): Promise<AiTokenReservationResult>;
  settle(reservationId: string, actualTokens: number): Promise<AiTokenReservation | null>;
  consumeEstimate(reservationId: string): Promise<AiTokenReservation | null>;
  release(reservationId: string): Promise<AiTokenReservation | null>;
}

export function ensureSqliteAiProviderSourceSchema(db: DatabaseLib.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_guild_provider_settings (
      guild_id TEXT PRIMARY KEY NOT NULL,
      preferred_provider TEXT NOT NULL DEFAULT 'openai'
        CHECK (preferred_provider IN ('openai', 'deepseek')),
      preferred_openai_model TEXT NOT NULL DEFAULT 'gpt56'
        CHECK (preferred_openai_model IN ('gpt56', 'gpt54_mini')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ai_provider_daily_budget (
      provider TEXT NOT NULL CHECK (provider IN ('openai', 'deepseek')),
      usage_date TEXT NOT NULL,
      confirmed_tokens INTEGER NOT NULL DEFAULT 0 CHECK (confirmed_tokens >= 0),
      reserved_tokens INTEGER NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
      observed_external_tokens INTEGER NOT NULL DEFAULT 0 CHECK (observed_external_tokens >= 0),
      observed_bot_tokens INTEGER NOT NULL DEFAULT 0 CHECK (observed_bot_tokens >= 0),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (provider, usage_date)
    );

    CREATE TABLE IF NOT EXISTS ai_provider_token_reservations (
      reservation_id TEXT PRIMARY KEY NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('openai', 'deepseek')),
      usage_date TEXT NOT NULL,
      reserved_tokens INTEGER NOT NULL CHECK (reserved_tokens >= 0),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'settled', 'released')),
      actual_tokens INTEGER CHECK (actual_tokens IS NULL OR actual_tokens >= 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      settled_at TEXT,
      FOREIGN KEY (provider, usage_date)
        REFERENCES ai_provider_daily_budget(provider, usage_date)
    );
  `);
  const columns = db.pragma("table_info(ai_guild_provider_settings)") as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "preferred_openai_model")) {
    db.exec(`
      ALTER TABLE ai_guild_provider_settings
      ADD COLUMN preferred_openai_model TEXT NOT NULL DEFAULT 'gpt56'
        CHECK (preferred_openai_model IN ('gpt56', 'gpt54_mini'))
    `);
  }
}

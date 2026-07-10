import type DatabaseLib from "better-sqlite3";
import type { AiProvider } from "./providerTypes.js";

export interface AiProviderSettingsRepository {
  getPreferredProvider(guildId: string): Promise<AiProvider>;
  setPreferredProvider(guildId: string, provider: AiProvider): Promise<void>;
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

export function ensureSqliteAiProviderSchema(db: DatabaseLib.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_guild_provider_settings (
      guild_id TEXT PRIMARY KEY NOT NULL,
      preferred_provider TEXT NOT NULL DEFAULT 'openai'
        CHECK (preferred_provider IN ('openai', 'deepseek')),
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
}

export class SqliteAiProviderSettingsRepository implements AiProviderSettingsRepository {
  constructor(private readonly db: DatabaseLib.Database) {}

  async getPreferredProvider(guildId: string): Promise<AiProvider> {
    const row = this.db
      .prepare("SELECT preferred_provider FROM ai_guild_provider_settings WHERE guild_id = ?")
      .get(guildId) as { preferred_provider: AiProvider } | undefined;
    return row?.preferred_provider ?? "openai";
  }

  async setPreferredProvider(guildId: string, provider: AiProvider): Promise<void> {
    this.db.prepare(`
      INSERT INTO ai_guild_provider_settings (guild_id, preferred_provider, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT (guild_id) DO UPDATE SET
        preferred_provider = excluded.preferred_provider,
        updated_at = excluded.updated_at
    `).run(guildId, provider);
  }
}

type SqliteBudgetRow = {
  confirmed_tokens: number;
  reserved_tokens: number;
  observed_external_tokens: number;
  observed_bot_tokens: number;
};

type SqliteReservationRow = {
  reservation_id: string;
  provider: AiProvider;
  usage_date: string;
  reserved_tokens: number;
  status: AiTokenReservationStatus;
  actual_tokens: number | null;
};

function assertTokenCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function toReservation(row: SqliteReservationRow): AiTokenReservation {
  return {
    reservationId: row.reservation_id,
    provider: row.provider,
    usageDate: row.usage_date,
    reservedTokens: row.reserved_tokens,
    status: row.status,
    actualTokens: row.actual_tokens,
  };
}

function effectiveTokens(row: SqliteBudgetRow): number {
  return row.observed_external_tokens
    + Math.max(row.observed_bot_tokens, row.confirmed_tokens)
    + row.reserved_tokens;
}

export class SqliteAiProviderBudgetRepository implements AiProviderBudgetRepository {
  constructor(private readonly db: DatabaseLib.Database) {}

  async tryReserve(input: AiTokenReservationRequest): Promise<AiTokenReservationResult> {
    assertTokenCount(input.reservedTokens, "reservedTokens");
    assertTokenCount(input.threshold, "threshold");
    assertTokenCount(input.snapshot.orgTargetTokens, "snapshot.orgTargetTokens");
    assertTokenCount(input.snapshot.botReportedTokens, "snapshot.botReportedTokens");

    const run = this.db.transaction((): AiTokenReservationResult => {
      const existing = this.getReservationRow(input.reservationId);
      if (existing) {
        const budget = this.getBudgetRow(existing.provider, existing.usage_date);
        return {
          allowed: existing.status !== "released",
          duplicate: true,
          effectiveTokens: budget ? effectiveTokens(budget) : 0,
          reason: existing.status === "released" ? "reservation_released" : undefined,
          reservation: toReservation(existing),
        };
      }

      this.db.prepare(`
        INSERT INTO ai_provider_daily_budget (provider, usage_date, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT (provider, usage_date) DO NOTHING
      `).run(input.provider, input.usageDate);

      const externalCandidate = Math.max(
        0,
        input.snapshot.orgTargetTokens - input.snapshot.botReportedTokens,
      );
      this.db.prepare(`
        UPDATE ai_provider_daily_budget
        SET observed_external_tokens = MAX(observed_external_tokens, ?),
            observed_bot_tokens = MAX(observed_bot_tokens, ?),
            updated_at = datetime('now')
        WHERE provider = ? AND usage_date = ?
      `).run(
        externalCandidate,
        input.snapshot.botReportedTokens,
        input.provider,
        input.usageDate,
      );

      const budget = this.getBudgetRow(input.provider, input.usageDate);
      if (!budget) throw new Error("AI provider daily budget row was not created");
      const projectedTokens = effectiveTokens(budget) + input.reservedTokens;
      if (projectedTokens > input.threshold) {
        return {
          allowed: false,
          duplicate: false,
          effectiveTokens: projectedTokens,
          reason: "threshold_exceeded",
        };
      }

      this.db.prepare(`
        INSERT INTO ai_provider_token_reservations (
          reservation_id, provider, usage_date, reserved_tokens, status, actual_tokens, created_at
        ) VALUES (?, ?, ?, ?, 'pending', NULL, datetime('now'))
      `).run(input.reservationId, input.provider, input.usageDate, input.reservedTokens);
      this.db.prepare(`
        UPDATE ai_provider_daily_budget
        SET reserved_tokens = reserved_tokens + ?, updated_at = datetime('now')
        WHERE provider = ? AND usage_date = ?
      `).run(input.reservedTokens, input.provider, input.usageDate);

      const reservation = this.getReservationRow(input.reservationId);
      if (!reservation) throw new Error("AI token reservation was not created");
      return {
        allowed: true,
        duplicate: false,
        effectiveTokens: projectedTokens,
        reservation: toReservation(reservation),
      };
    });

    return run.immediate();
  }

  async settle(reservationId: string, actualTokens: number): Promise<AiTokenReservation | null> {
    assertTokenCount(actualTokens, "actualTokens");
    return this.finishReservation(reservationId, "settled", actualTokens);
  }

  async consumeEstimate(reservationId: string): Promise<AiTokenReservation | null> {
    return this.finishReservation(reservationId, "settled", null);
  }

  async release(reservationId: string): Promise<AiTokenReservation | null> {
    return this.finishReservation(reservationId, "released", null);
  }

  private finishReservation(
    reservationId: string,
    targetStatus: "settled" | "released",
    requestedActualTokens: number | null,
  ): AiTokenReservation | null {
    const run = this.db.transaction((): AiTokenReservation | null => {
      const current = this.getReservationRow(reservationId);
      if (!current) return null;
      if (current.status !== "pending") return toReservation(current);

      const actualTokens = targetStatus === "settled"
        ? (requestedActualTokens ?? current.reserved_tokens)
        : null;
      this.db.prepare(`
        UPDATE ai_provider_daily_budget
        SET reserved_tokens = MAX(0, reserved_tokens - ?),
            confirmed_tokens = confirmed_tokens + ?,
            updated_at = datetime('now')
        WHERE provider = ? AND usage_date = ?
      `).run(
        current.reserved_tokens,
        actualTokens ?? 0,
        current.provider,
        current.usage_date,
      );
      this.db.prepare(`
        UPDATE ai_provider_token_reservations
        SET status = ?, actual_tokens = ?, settled_at = datetime('now')
        WHERE reservation_id = ? AND status = 'pending'
      `).run(targetStatus, actualTokens, reservationId);

      const updated = this.getReservationRow(reservationId);
      if (!updated) throw new Error("AI token reservation disappeared during settlement");
      return toReservation(updated);
    });
    return run.immediate();
  }

  private getBudgetRow(provider: AiProvider, usageDate: string): SqliteBudgetRow | undefined {
    return this.db.prepare(`
      SELECT confirmed_tokens, reserved_tokens, observed_external_tokens, observed_bot_tokens
      FROM ai_provider_daily_budget
      WHERE provider = ? AND usage_date = ?
    `).get(provider, usageDate) as SqliteBudgetRow | undefined;
  }

  private getReservationRow(reservationId: string): SqliteReservationRow | undefined {
    return this.db.prepare(`
      SELECT reservation_id, provider, usage_date, reserved_tokens, status, actual_tokens
      FROM ai_provider_token_reservations
      WHERE reservation_id = ?
    `).get(reservationId) as SqliteReservationRow | undefined;
  }
}

import type { Pool, PoolClient } from "pg";
import { quotePgIdent } from "../../core/db/postgres.js";
import type { AiProvider, AiRoutePreference } from "./providerTypes.js";
import type {
  AiProviderBudgetRepository,
  AiProviderSettingsRepository,
  AiTokenReservation,
  AiTokenReservationRequest,
  AiTokenReservationResult,
  AiTokenReservationStatus,
} from "./aiProviderRepository.js";

export async function ensurePostgresAiProviderSchema(pool: Pool, schemaName: string): Promise<void> {
  const schema = quotePgIdent(schemaName);
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${schema}.ai_guild_provider_settings (
      guild_id text PRIMARY KEY,
      preferred_provider text NOT NULL DEFAULT 'openai'
        CHECK (preferred_provider IN ('openai', 'deepseek')),
      preferred_openai_model text NOT NULL DEFAULT 'gpt56'
        CHECK (preferred_openai_model IN ('gpt56', 'gpt54_mini')),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS ${schema}.ai_provider_daily_budget (
      provider text NOT NULL CHECK (provider IN ('openai', 'deepseek')),
      usage_date date NOT NULL,
      confirmed_tokens bigint NOT NULL DEFAULT 0 CHECK (confirmed_tokens >= 0),
      reserved_tokens bigint NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
      observed_external_tokens bigint NOT NULL DEFAULT 0 CHECK (observed_external_tokens >= 0),
      observed_bot_tokens bigint NOT NULL DEFAULT 0 CHECK (observed_bot_tokens >= 0),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (provider, usage_date)
    );

    CREATE TABLE IF NOT EXISTS ${schema}.ai_provider_token_reservations (
      reservation_id text PRIMARY KEY,
      provider text NOT NULL CHECK (provider IN ('openai', 'deepseek')),
      usage_date date NOT NULL,
      reserved_tokens bigint NOT NULL CHECK (reserved_tokens >= 0),
      status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'settled', 'released')),
      actual_tokens bigint CHECK (actual_tokens IS NULL OR actual_tokens >= 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      settled_at timestamptz,
      FOREIGN KEY (provider, usage_date)
        REFERENCES ${schema}.ai_provider_daily_budget(provider, usage_date)
    );

    ALTER TABLE ${schema}.ai_guild_provider_settings
      ADD COLUMN IF NOT EXISTS preferred_openai_model text NOT NULL DEFAULT 'gpt56'
        CHECK (preferred_openai_model IN ('gpt56', 'gpt54_mini'));
  `);
}

export class PostgresAiProviderSettingsRepository implements AiProviderSettingsRepository {
  constructor(readonly pool: Pool) {}

  async getPreference(guildId: string): Promise<AiRoutePreference> {
    const result = await this.pool.query<{
      preferred_provider: AiProvider;
      preferred_openai_model: AiRoutePreference["openAiModel"];
    }>(
      "SELECT preferred_provider, preferred_openai_model FROM ai_guild_provider_settings WHERE guild_id = $1",
      [guildId],
    );
    const row = result.rows[0];
    return row
      ? { provider: row.preferred_provider, openAiModel: row.preferred_openai_model }
      : { provider: "openai", openAiModel: "gpt56" };
  }

  async setPreference(guildId: string, preference: AiRoutePreference): Promise<void> {
    await this.pool.query(`
      INSERT INTO ai_guild_provider_settings (guild_id, preferred_provider, preferred_openai_model, updated_at)
      VALUES ($1, $2, $3, now())
      ON CONFLICT (guild_id) DO UPDATE SET
        preferred_provider = excluded.preferred_provider,
        preferred_openai_model = excluded.preferred_openai_model,
        updated_at = excluded.updated_at
    `, [guildId, preference.provider, preference.openAiModel]);
  }
}

type PgBudgetRow = {
  confirmed_tokens: string | number;
  reserved_tokens: string | number;
  observed_external_tokens: string | number;
  observed_bot_tokens: string | number;
};

type PgReservationRow = {
  reservation_id: string;
  provider: AiProvider;
  usage_date: string;
  reserved_tokens: string | number;
  status: AiTokenReservationStatus;
  actual_tokens: string | number | null;
};

function checkedTokenCount(value: string | number, name: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return parsed;
}

function validateReservationRequest(input: AiTokenReservationRequest): void {
  checkedTokenCount(input.reservedTokens, "reservedTokens");
  checkedTokenCount(input.threshold, "threshold");
  checkedTokenCount(input.snapshot.orgTargetTokens, "snapshot.orgTargetTokens");
  checkedTokenCount(input.snapshot.botReportedTokens, "snapshot.botReportedTokens");
}

function mapReservation(row: PgReservationRow): AiTokenReservation {
  return {
    reservationId: row.reservation_id,
    provider: row.provider,
    usageDate: row.usage_date,
    reservedTokens: checkedTokenCount(row.reserved_tokens, "reservation.reservedTokens"),
    status: row.status,
    actualTokens: row.actual_tokens === null
      ? null
      : checkedTokenCount(row.actual_tokens, "reservation.actualTokens"),
  };
}

function pgEffectiveTokens(row: PgBudgetRow): number {
  return checkedTokenCount(row.observed_external_tokens, "observedExternalTokens")
    + Math.max(
      checkedTokenCount(row.observed_bot_tokens, "observedBotTokens"),
      checkedTokenCount(row.confirmed_tokens, "confirmedTokens"),
    )
    + checkedTokenCount(row.reserved_tokens, "reservedTokens");
}

const RESERVATION_COLUMNS = `
  reservation_id, provider, usage_date::text AS usage_date,
  reserved_tokens, status, actual_tokens
`;

export class PostgresAiProviderBudgetRepository implements AiProviderBudgetRepository {
  constructor(readonly pool: Pool) {}

  async tryReserve(input: AiTokenReservationRequest): Promise<AiTokenReservationResult> {
    validateReservationRequest(input);
    return this.withTransaction(async (client) => {
      await this.lockReservationId(client, input.reservationId);
      const existingResult = await client.query<PgReservationRow>(`
        SELECT ${RESERVATION_COLUMNS}
        FROM ai_provider_token_reservations
        WHERE reservation_id = $1
        FOR UPDATE
      `, [input.reservationId]);
      const existing = existingResult.rows[0];
      if (existing) {
        const budgetResult = await client.query<PgBudgetRow>(`
          SELECT confirmed_tokens, reserved_tokens, observed_external_tokens, observed_bot_tokens
          FROM ai_provider_daily_budget
          WHERE provider = $1 AND usage_date = $2
        `, [existing.provider, existing.usage_date]);
        return {
          allowed: existing.status !== "released",
          duplicate: true,
          effectiveTokens: budgetResult.rows[0] ? pgEffectiveTokens(budgetResult.rows[0]) : 0,
          reason: existing.status === "released" ? "reservation_released" : undefined,
          reservation: mapReservation(existing),
        };
      }

      await client.query(`
        INSERT INTO ai_provider_daily_budget (provider, usage_date, updated_at)
        VALUES ($1, $2, now())
        ON CONFLICT (provider, usage_date) DO NOTHING
      `, [input.provider, input.usageDate]);
      await client.query(`
        SELECT provider
        FROM ai_provider_daily_budget
        WHERE provider = $1 AND usage_date = $2
        FOR UPDATE
      `, [input.provider, input.usageDate]);

      const externalCandidate = Math.max(
        0,
        input.snapshot.orgTargetTokens - input.snapshot.botReportedTokens,
      );
      const budgetResult = await client.query<PgBudgetRow>(`
        UPDATE ai_provider_daily_budget
        SET observed_external_tokens = GREATEST(observed_external_tokens, $1),
            observed_bot_tokens = GREATEST(observed_bot_tokens, $2),
            updated_at = now()
        WHERE provider = $3 AND usage_date = $4
        RETURNING confirmed_tokens, reserved_tokens,
          observed_external_tokens, observed_bot_tokens
      `, [
        externalCandidate,
        input.snapshot.botReportedTokens,
        input.provider,
        input.usageDate,
      ]);
      const budget = budgetResult.rows[0];
      if (!budget) throw new Error("AI provider daily budget row was not created");
      const projectedTokens = pgEffectiveTokens(budget) + input.reservedTokens;
      if (projectedTokens > input.threshold) {
        return {
          allowed: false,
          duplicate: false,
          effectiveTokens: projectedTokens,
          reason: "threshold_exceeded",
        };
      }

      await client.query(`
        INSERT INTO ai_provider_token_reservations (
          reservation_id, provider, usage_date, reserved_tokens, status, actual_tokens, created_at
        ) VALUES ($1, $2, $3, $4, 'pending', NULL, now())
      `, [input.reservationId, input.provider, input.usageDate, input.reservedTokens]);
      await client.query(`
        UPDATE ai_provider_daily_budget
        SET reserved_tokens = reserved_tokens + $1, updated_at = now()
        WHERE provider = $2 AND usage_date = $3
      `, [input.reservedTokens, input.provider, input.usageDate]);
      return {
        allowed: true,
        duplicate: false,
        effectiveTokens: projectedTokens,
        reservation: {
          reservationId: input.reservationId,
          provider: input.provider,
          usageDate: input.usageDate,
          reservedTokens: input.reservedTokens,
          status: "pending",
          actualTokens: null,
        },
      };
    });
  }

  async settle(reservationId: string, actualTokens: number): Promise<AiTokenReservation | null> {
    checkedTokenCount(actualTokens, "actualTokens");
    return this.finishReservation(reservationId, "settled", actualTokens);
  }

  async consumeEstimate(reservationId: string): Promise<AiTokenReservation | null> {
    return this.finishReservation(reservationId, "settled", null);
  }

  async release(reservationId: string): Promise<AiTokenReservation | null> {
    return this.finishReservation(reservationId, "released", null);
  }

  private async finishReservation(
    reservationId: string,
    targetStatus: "settled" | "released",
    requestedActualTokens: number | null,
  ): Promise<AiTokenReservation | null> {
    return this.withTransaction(async (client) => {
      await this.lockReservationId(client, reservationId);
      const currentResult = await client.query<PgReservationRow>(`
        SELECT ${RESERVATION_COLUMNS}
        FROM ai_provider_token_reservations
        WHERE reservation_id = $1
        FOR UPDATE
      `, [reservationId]);
      const current = currentResult.rows[0];
      if (!current) return null;
      if (current.status !== "pending") return mapReservation(current);

      await client.query(`
        SELECT provider
        FROM ai_provider_daily_budget
        WHERE provider = $1 AND usage_date = $2
        FOR UPDATE
      `, [current.provider, current.usage_date]);
      const reservedTokens = checkedTokenCount(current.reserved_tokens, "reservation.reservedTokens");
      const actualTokens = targetStatus === "settled"
        ? (requestedActualTokens ?? reservedTokens)
        : null;
      await client.query(`
        UPDATE ai_provider_daily_budget
        SET reserved_tokens = GREATEST(0, reserved_tokens - $1),
            confirmed_tokens = confirmed_tokens + $2,
            updated_at = now()
        WHERE provider = $3 AND usage_date = $4
      `, [reservedTokens, actualTokens ?? 0, current.provider, current.usage_date]);
      const updatedResult = await client.query<PgReservationRow>(`
        UPDATE ai_provider_token_reservations
        SET status = $1, actual_tokens = $2, settled_at = now()
        WHERE reservation_id = $3 AND status = 'pending'
        RETURNING ${RESERVATION_COLUMNS}
      `, [targetStatus, actualTokens, reservationId]);
      const updated = updatedResult.rows[0];
      if (!updated) throw new Error("AI token reservation disappeared during settlement");
      return mapReservation(updated);
    });
  }

  private async lockReservationId(client: PoolClient, reservationId: string): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [reservationId]);
  }

  private async withTransaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}

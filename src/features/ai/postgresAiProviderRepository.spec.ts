import assert from "node:assert/strict";
import { createPgPool, quotePgIdent } from "../../core/db/postgres.js";
import {
  ensurePostgresAiProviderSchema,
  PostgresAiProviderBudgetRepository,
  PostgresAiProviderSettingsRepository,
} from "./postgresAiProviderRepository.js";

type CapturingPool = {
  queries: string[];
  query: (sql: string) => Promise<{ rows: unknown[] }>;
};

function createCapturingPool(): CapturingPool {
  return {
    queries: [],
    async query(sql: string): Promise<{ rows: unknown[] }> {
      this.queries.push(sql);
      return { rows: [] };
    },
  };
}

function tempSchemaName(): string {
  return `ai_provider_spec_${process.pid}_${Date.now()}`;
}

async function assertPostgresDdl(): Promise<void> {
  const pool = createCapturingPool();
  await ensurePostgresAiProviderSchema(
    pool as unknown as Parameters<typeof ensurePostgresAiProviderSchema>[0],
    "ai_provider_test",
  );
  const sql = pool.queries.join("\n");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "ai_provider_test"\.ai_guild_provider_settings/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "ai_provider_test"\.ai_provider_daily_budget/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "ai_provider_test"\.ai_provider_token_reservations/);
  assert.match(sql, /preferred_provider IN \('openai', 'deepseek'\)/);
  assert.match(sql, /status IN \('pending', 'settled', 'released'\)/);
  assert.match(sql, /PRIMARY KEY \(provider, usage_date\)/);
  assert.match(sql, /FOREIGN KEY \(provider, usage_date\)/);
}

async function assertPostgresIntegration(): Promise<boolean> {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) {
    console.log("postgresAiProviderRepository.spec.ts: TEST_DATABASE_URL is not set; skipping PostgreSQL integration assertions");
    return false;
  }

  const schemaName = tempSchemaName();
  const pool = await createPgPool(connectionString, schemaName);
  try {
    await ensurePostgresAiProviderSchema(pool, schemaName);
    const settings = new PostgresAiProviderSettingsRepository(pool);
    assert.equal(await settings.getPreferredProvider("guild-missing"), "openai");
    await settings.setPreferredProvider("guild-1", "deepseek");
    assert.equal(await settings.getPreferredProvider("guild-1"), "deepseek");

    const budget = new PostgresAiProviderBudgetRepository(pool);
    const input = {
      provider: "openai" as const,
      usageDate: "2026-07-10",
      reservedTokens: 60,
      threshold: 100,
      snapshot: { orgTargetTokens: 0, botReportedTokens: 0 },
    };
    const competing = await Promise.all([
      budget.tryReserve({ ...input, reservationId: "competing-1" }),
      budget.tryReserve({ ...input, reservationId: "competing-2" }),
    ]);
    assert.equal(competing.filter((result) => result.allowed).length, 1);

    const duplicate = await budget.tryReserve({
      ...input,
      reservationId: competing[0]!.allowed ? "competing-1" : "competing-2",
      reservedTokens: 100,
      threshold: 1,
    });
    assert.equal(duplicate.allowed, true);
    assert.equal(duplicate.duplicate, true);

    const acceptedId = competing[0]!.allowed ? "competing-1" : "competing-2";
    assert.equal((await budget.settle(acceptedId, 50))?.actualTokens, 50);
    assert.equal((await budget.settle(acceptedId, 999))?.actualTokens, 50);

    const nextDay = await budget.tryReserve({
      ...input,
      reservationId: "next-day",
      usageDate: "2026-07-11",
      reservedTokens: 100,
    });
    assert.equal(nextDay.allowed, true);
    assert.equal((await budget.release("next-day"))?.status, "released");
    assert.equal((await budget.release("next-day"))?.status, "released");
    return true;
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${quotePgIdent(schemaName)} CASCADE`);
    await pool.end();
  }
}

async function run(): Promise<void> {
  await assertPostgresDdl();
  await assertPostgresIntegration();
}

void run()
  .then(() => {
    console.log("postgresAiProviderRepository.spec.ts: all available assertions passed");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

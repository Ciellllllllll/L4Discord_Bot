import assert from "node:assert/strict";
import { createPgPool, quotePgIdent } from "../../core/db/postgres.js";
import {
  ensurePostgresAiProviderSchema,
  migratePostgresAiProviderOpenRouterBudgetSchema,
  migratePostgresAiProviderOpenRouterSchema,
  PostgresAiProviderBudgetRepository,
  PostgresAiProviderSettingsRepository,
} from "./postgresAiProviderRepository.js";
import { getOptionalPostgresTestUrl } from "../../test/postgresTestEnv.js";

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
  assert.match(sql, /preferred_provider IN \('openai', 'deepseek', 'openrouter'\)/);
  assert.match(sql, /provider IN \('openai', 'deepseek', 'openrouter'\)/);
  assert.match(sql, /preferred_openai_model/);
  assert.match(sql, /preferred_openai_model IN \('gpt56', 'gpt54_mini'\)/);
  assert.match(sql, /ALTER TABLE .*ai_guild_provider_settings/s);
  assert.match(sql, /status IN \('pending', 'settled', 'released'\)/);
  assert.match(sql, /PRIMARY KEY \(provider, usage_date\)/);
  assert.match(sql, /FOREIGN KEY \(provider, usage_date\)/);

  const migrationPool = createCapturingPool();
  await migratePostgresAiProviderOpenRouterSchema(
    migrationPool as unknown as Parameters<typeof migratePostgresAiProviderOpenRouterSchema>[0],
    "ai_provider_test",
  );
  const migrationSql = migrationPool.queries.join("\n");
  assert.match(migrationSql, /DROP CONSTRAINT IF EXISTS ai_guild_provider_settings_preferred_provider_check/);
  assert.match(migrationSql, /preferred_provider IN \('openai', 'deepseek', 'openrouter'\)/);

  const budgetMigrationPool = createCapturingPool();
  await migratePostgresAiProviderOpenRouterBudgetSchema(
    budgetMigrationPool as unknown as Parameters<typeof migratePostgresAiProviderOpenRouterBudgetSchema>[0],
    "ai_provider_test",
  );
  const budgetMigrationSql = budgetMigrationPool.queries.join("\n");
  assert.match(budgetMigrationSql, /DROP CONSTRAINT IF EXISTS ai_provider_daily_budget_provider_check/);
  assert.match(budgetMigrationSql, /DROP CONSTRAINT IF EXISTS ai_provider_token_reservations_provider_check/);
  assert.match(budgetMigrationSql, /provider IN \('openai', 'deepseek', 'openrouter'\)/);
}

async function assertPostgresIntegration(): Promise<boolean> {
  const connectionString = getOptionalPostgresTestUrl("TEST_DATABASE_URL", "postgresAiProviderRepository.spec.ts");
  if (!connectionString) return false;

  const schemaName = tempSchemaName();
  const pool = await createPgPool(connectionString, schemaName);
  try {
    await ensurePostgresAiProviderSchema(pool, schemaName);
    const settings = new PostgresAiProviderSettingsRepository(pool);
    assert.deepEqual(await settings.getPreference("guild-missing"), {
      provider: "openai",
      openAiModel: "gpt56",
    });
    await settings.setPreference("guild-1", { provider: "openai", openAiModel: "gpt54_mini" });
    assert.deepEqual(await new PostgresAiProviderSettingsRepository(pool).getPreference("guild-1"), {
      provider: "openai",
      openAiModel: "gpt54_mini",
    });
    await settings.setPreference("guild-1", { provider: "deepseek", openAiModel: "gpt54_mini" });
    assert.deepEqual(await new PostgresAiProviderSettingsRepository(pool).getPreference("guild-1"), {
      provider: "deepseek",
      openAiModel: "gpt54_mini",
    });
    await settings.setPreference("guild-1", { provider: "openrouter", openAiModel: "gpt54_mini" });
    assert.deepEqual(await new PostgresAiProviderSettingsRepository(pool).getPreference("guild-1"), {
      provider: "openrouter",
      openAiModel: "gpt54_mini",
    });

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

    const openRouter = await budget.tryReserve({
      ...input,
      provider: "openrouter",
      reservationId: "openrouter-1",
      reservedTokens: 10,
    });
    assert.equal(openRouter.allowed, true);
    assert.equal((await budget.release("openrouter-1"))?.status, "released");
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

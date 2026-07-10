import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureSqliteAiProviderSchema,
  SqliteAiProviderBudgetRepository,
  SqliteAiProviderSettingsRepository,
} from "./aiProviderRepository.js";

async function assertSqliteProviderPreference(): Promise<void> {
  const db = new Database(":memory:");
  try {
    ensureSqliteAiProviderSchema(db);
    const repo = new SqliteAiProviderSettingsRepository(db);

    assert.equal(await repo.getPreferredProvider("guild-missing"), "openai");
    await repo.setPreferredProvider("guild-1", "deepseek");
    assert.equal(await repo.getPreferredProvider("guild-1"), "deepseek");
    await repo.setPreferredProvider("guild-1", "openai");
    assert.equal(await repo.getPreferredProvider("guild-1"), "openai");

    assert.throws(
      () => db.prepare("INSERT INTO ai_guild_provider_settings (guild_id, preferred_provider) VALUES (?, ?)").run("guild-invalid", "other"),
      /CHECK constraint failed/,
    );
  } finally {
    db.close();
  }
}

type DailyBudgetRow = {
  confirmed_tokens: number;
  reserved_tokens: number;
  observed_external_tokens: number;
  observed_bot_tokens: number;
};

function getBudgetRow(db: Database.Database, usageDate: string): DailyBudgetRow {
  return db.prepare(`
    SELECT confirmed_tokens, reserved_tokens, observed_external_tokens, observed_bot_tokens
    FROM ai_provider_daily_budget
    WHERE provider = 'openai' AND usage_date = ?
  `).get(usageDate) as DailyBudgetRow;
}

async function assertSqliteBudgetReservationAndMonotonicObservation(): Promise<void> {
  const db = new Database(":memory:");
  try {
    ensureSqliteAiProviderSchema(db);
    const repo = new SqliteAiProviderBudgetRepository(db);
    const first = await repo.tryReserve({
      reservationId: "reserve-1",
      provider: "openai",
      usageDate: "2026-07-10",
      reservedTokens: 100,
      threshold: 1_100,
      snapshot: { orgTargetTokens: 1_000, botReportedTokens: 400 },
    });
    assert.equal(first.allowed, true);
    assert.equal(first.duplicate, false);
    assert.equal(first.effectiveTokens, 1_100);
    assert.deepEqual(getBudgetRow(db, "2026-07-10"), {
      confirmed_tokens: 0,
      reserved_tokens: 100,
      observed_external_tokens: 600,
      observed_bot_tokens: 400,
    });

    const duplicate = await repo.tryReserve({
      reservationId: "reserve-1",
      provider: "openai",
      usageDate: "2026-07-10",
      reservedTokens: 999,
      threshold: 1,
      snapshot: { orgTargetTokens: 1, botReportedTokens: 1 },
    });
    assert.equal(duplicate.allowed, true);
    assert.equal(duplicate.duplicate, true);
    assert.equal(getBudgetRow(db, "2026-07-10").reserved_tokens, 100);

    const rejected = await repo.tryReserve({
      reservationId: "reserve-2",
      provider: "openai",
      usageDate: "2026-07-10",
      reservedTokens: 1,
      threshold: 1_100,
      snapshot: { orgTargetTokens: 900, botReportedTokens: 300 },
    });
    assert.deepEqual(rejected, {
      allowed: false,
      duplicate: false,
      effectiveTokens: 1_101,
      reason: "threshold_exceeded",
    });
    assert.deepEqual(getBudgetRow(db, "2026-07-10"), {
      confirmed_tokens: 0,
      reserved_tokens: 100,
      observed_external_tokens: 600,
      observed_bot_tokens: 400,
    });
  } finally {
    db.close();
  }
}

async function assertSqliteSettlementIsIdempotent(): Promise<void> {
  const db = new Database(":memory:");
  try {
    ensureSqliteAiProviderSchema(db);
    const repo = new SqliteAiProviderBudgetRepository(db);
    const reserve = (reservationId: string, reservedTokens: number) => repo.tryReserve({
      reservationId,
      provider: "openai",
      usageDate: "2026-07-10",
      reservedTokens,
      threshold: 10_000,
      snapshot: { orgTargetTokens: 0, botReportedTokens: 0 },
    });

    await reserve("settle", 100);
    assert.equal((await repo.settle("settle", 80))?.status, "settled");
    assert.equal((await repo.settle("settle", 999))?.actualTokens, 80);
    assert.deepEqual(getBudgetRow(db, "2026-07-10"), {
      confirmed_tokens: 80,
      reserved_tokens: 0,
      observed_external_tokens: 0,
      observed_bot_tokens: 0,
    });

    await reserve("consume", 50);
    assert.equal((await repo.consumeEstimate("consume"))?.actualTokens, 50);
    assert.equal((await repo.consumeEstimate("consume"))?.actualTokens, 50);
    assert.deepEqual(getBudgetRow(db, "2026-07-10"), {
      confirmed_tokens: 130,
      reserved_tokens: 0,
      observed_external_tokens: 0,
      observed_bot_tokens: 0,
    });

    await reserve("release", 30);
    assert.equal((await repo.release("release"))?.status, "released");
    assert.equal((await repo.release("release"))?.status, "released");
    assert.deepEqual(getBudgetRow(db, "2026-07-10"), {
      confirmed_tokens: 130,
      reserved_tokens: 0,
      observed_external_tokens: 0,
      observed_bot_tokens: 0,
    });
    assert.equal(await repo.settle("missing", 10), null);
  } finally {
    db.close();
  }
}

async function assertSqliteUtcDayIsolationAndPendingPreservation(): Promise<void> {
  const db = new Database(":memory:");
  try {
    ensureSqliteAiProviderSchema(db);
    const repo = new SqliteAiProviderBudgetRepository(db);
    await repo.tryReserve({
      reservationId: "day-one-pending",
      provider: "openai",
      usageDate: "2026-07-10",
      reservedTokens: 90,
      threshold: 100,
      snapshot: { orgTargetTokens: 0, botReportedTokens: 0 },
    });
    const nextDay = await repo.tryReserve({
      reservationId: "day-two",
      provider: "openai",
      usageDate: "2026-07-11",
      reservedTokens: 100,
      threshold: 100,
      snapshot: { orgTargetTokens: 0, botReportedTokens: 0 },
    });
    assert.equal(nextDay.allowed, true);
    assert.equal(getBudgetRow(db, "2026-07-10").reserved_tokens, 90);
    assert.equal(getBudgetRow(db, "2026-07-11").reserved_tokens, 100);
  } finally {
    db.close();
  }
}

async function assertSqliteCompetingReservations(): Promise<void> {
  const dbPath = join(tmpdir(), `l4-ai-budget-${process.pid}-${randomUUID()}.sqlite`);
  const firstDb = new Database(dbPath);
  const secondDb = new Database(dbPath);
  try {
    firstDb.pragma("busy_timeout = 5000");
    secondDb.pragma("busy_timeout = 5000");
    ensureSqliteAiProviderSchema(firstDb);
    const firstRepo = new SqliteAiProviderBudgetRepository(firstDb);
    const secondRepo = new SqliteAiProviderBudgetRepository(secondDb);
    const input = {
      provider: "openai" as const,
      usageDate: "2026-07-10",
      reservedTokens: 60,
      threshold: 100,
      snapshot: { orgTargetTokens: 0, botReportedTokens: 0 },
    };
    const results = await Promise.all([
      firstRepo.tryReserve({ ...input, reservationId: "competing-1" }),
      secondRepo.tryReserve({ ...input, reservationId: "competing-2" }),
    ]);
    assert.equal(results.filter((result) => result.allowed).length, 1);
    assert.equal(getBudgetRow(firstDb, "2026-07-10").reserved_tokens, 60);
  } finally {
    firstDb.close();
    secondDb.close();
    rmSync(dbPath, { force: true });
  }
}

async function run(): Promise<void> {
  await assertSqliteProviderPreference();
  await assertSqliteBudgetReservationAndMonotonicObservation();
  await assertSqliteSettlementIsIdempotent();
  await assertSqliteUtcDayIsolationAndPendingPreservation();
  await assertSqliteCompetingReservations();
}

void run()
  .then(() => {
    console.log("aiProviderRepository.spec.ts: all assertions passed");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

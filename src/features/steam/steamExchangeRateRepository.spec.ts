import assert from "node:assert/strict";
import { test } from "node:test";
import { ensurePostgresMainSchema } from "../../core/db/postgresMainSchema.js";
import {
  STEAM_EXCHANGE_SYMBOL,
  SteamExchangeRateRepository,
  parseYahooUsdJpyRate,
} from "./steamExchangeRateRepository.js";

test("Yahoo Chart APIのJPY=Xから最新の有効な終値を取り出す", () => {
  assert.equal(parseYahooUsdJpyRate({
    chart: { result: [{ indicators: { quote: [{ close: [149.2, null, 150.15] }] } }] },
  }), 150.15);
  assert.equal(parseYahooUsdJpyRate({
    chart: { result: [{ indicators: { quote: [{ close: [null, "150.1"] }] } }] },
  }), null);
  assert.equal(parseYahooUsdJpyRate({ chart: { result: [] } }), null);
});

test("新規 main schema の steam_exchange_rates は rate_date 単独キーで作られる", async () => {
  const queries: string[] = [];
  await ensurePostgresMainSchema({
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [], rowCount: 0 };
    },
  } as never);
  const sql = queries.join("\n");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS steam_exchange_rates/i);
  assert.match(sql, /rate_date date NOT NULL/i);
  assert.match(sql, /PRIMARY KEY \(rate_date\)/i);
  assert.match(sql, /ON steam_exchange_rates \(rate_date DESC\)/i);
  assert.doesNotMatch(sql, /symbol text NOT NULL/i);
  assert.doesNotMatch(sql, /PRIMARY KEY \(symbol, rate_date\)/i);
});

test("本番未使用のため、旧symbol互換v17 migrationを登録しない", async () => {
  const module = await import("./steamExchangeRateRepository.js");
  assert.equal("migratePostgresSteamExchangeRateSingleSymbolSchema" in module, false);
});

test("repository は symbol を保存キーに使わず、Yahoo API 用定数だけを残す", async () => {
  const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const repository = new SteamExchangeRateRepository({
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (/SELECT rate/i.test(sql)) return { rows: [{ rate: "150.15" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  } as never);

  assert.equal(STEAM_EXCHANGE_SYMBOL, "JPY=X");
  assert.equal(await repository.tryClaimDailyFetch("2026-08-21"), true);
  await repository.recordSuccess("2026-08-21", 150.15);
  await repository.recordFailure("2026-08-21", new Error("boom"));
  assert.equal(await repository.getLatestSuccessfulRate(), 150.15);

  assert.match(calls[0]!.sql, /INSERT INTO steam_exchange_rates \(rate_date, status\)/i);
  assert.match(calls[0]!.sql, /ON CONFLICT \(rate_date\) DO NOTHING/i);
  assert.deepEqual(calls[0]!.params, ["2026-08-21"]);
  assert.doesNotMatch(calls[0]!.sql, /symbol/i);

  assert.match(calls[1]!.sql, /WHERE rate_date = \$2/i);
  assert.deepEqual(calls[1]!.params, [150.15, "2026-08-21"]);
  assert.doesNotMatch(calls[1]!.sql, /symbol =/i);

  assert.match(calls[2]!.sql, /WHERE rate_date = \$2/i);
  assert.deepEqual(calls[2]!.params, ["boom", "2026-08-21"]);
  assert.doesNotMatch(calls[2]!.sql, /symbol =/i);

  assert.match(calls[3]!.sql, /WHERE status = 'succeeded' AND rate IS NOT NULL/i);
  assert.match(calls[3]!.sql, /ORDER BY rate_date DESC/i);
  assert.equal(calls[3]!.params, undefined);
  assert.doesNotMatch(calls[3]!.sql, /symbol/i);
});

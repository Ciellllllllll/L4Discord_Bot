import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  SqliteVcRankingRepository,
  mergedIntervalSeconds,
} from "../../adapters/legacyDb/sqliteVcRankingRepository.js";
import { ensureVcTimeSchema } from "./vcTimeSchema.js";

async function run(): Promise<void> {
  assert.equal(
    mergedIntervalSeconds([
      { startMs: 0, endMs: 10_000 },
      { startMs: 5_000, endMs: 15_000 },
      { startMs: 20_000, endMs: 25_000 },
    ]),
    20,
  );

  const db = new Database(":memory:");
  ensureVcTimeSchema(db);
  const insert = db.prepare(`
    INSERT INTO sessions (guild_id, user_id, channel_id, started_at, ended_at, duration_sec)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  insert.run(100, 200, 1, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:10.000Z", 10);
  insert.run(100, 200, 1, "2026-01-01T00:00:05.000Z", "2026-01-01T00:00:15.000Z", 10);
  insert.run(100, 300, 1, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:20.000Z", 20);
  insert.run(100, 400, 1, "2026-01-01T00:00:00.000Z", null, null);

  const repo = new SqliteVcRankingRepository(db, "UTC");
  const rows = await repo.getRanking("100", "all");
  assert.deepEqual(rows.slice(0, 3), [
    { userId: "300", seconds: 20 },
    { userId: "200", seconds: 15 },
  ]);

  db.close();
}

void run()
  .then(() => {
    console.log("vcRankingRepository.spec.ts: all assertions passed");
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

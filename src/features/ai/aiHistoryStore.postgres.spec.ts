import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Kysely, PostgresDialect } from "kysely";
import { createPgPool, quotePgIdent } from "../../core/db/postgres.js";
import type { AiHistoryDatabase } from "../../core/db/types.js";
import { getOptionalPostgresTestUrl } from "../../test/postgresTestEnv.js";
import { ensurePostgresAiHistorySchema } from "./aiHistorySchema.js";
import { AiHistoryStore } from "./aiHistoryStore.js";

test("AiHistoryStore persists jsonb meta, Date timestamps, since filtering, and user/assistant order in PostgreSQL", async (t) => {
  const connectionString = getOptionalPostgresTestUrl(
    "TEST_DATABASE_URL",
    "aiHistoryStore.postgres.spec.ts",
  );
  if (!connectionString) {
    t.skip("TEST_DATABASE_URL is not set");
    return;
  }

  const schemaName = `ai_history_store_spec_${process.pid}_${Date.now()}`;
  const pool = await createPgPool(connectionString, schemaName);
  const db = new Kysely<AiHistoryDatabase>({
    dialect: new PostgresDialect({ pool }),
  });

  try {
    await ensurePostgresAiHistorySchema(pool);
    const store = new AiHistoryStore(db);

    await store.appendPair("g1", "u1", "first question", "first answer", { provider: "openai" });
    const afterFirst = new Date(Date.now() + 5);
    await new Promise((resolve) => setTimeout(resolve, 15));
    await store.appendPair("g1", "u1", "second question", "second answer", { provider: "deepseek" });
    await store.appendPair("g1", "u1", "r18 question", "r18 answer", { r18: true, provider: "local_llm" });

    assert.equal(await store.countSince("g1", "u1", null, "normal"), 4);
    assert.equal(await store.countSince("g1", "u1", afterFirst, "normal"), 2);
    assert.equal(await store.countSince("g1", "u1", null, "r18"), 2);

    const normalMessages = await store.loadMessages("g1", "u1", null, "normal", 10);
    assert.deepEqual(normalMessages, [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second question" },
      { role: "assistant", content: "second answer" },
    ]);

    const sinceMessages = await store.loadMessages("g1", "u1", afterFirst, "normal", 10);
    assert.deepEqual(sinceMessages, [
      { role: "user", content: "second question" },
      { role: "assistant", content: "second answer" },
    ]);

    const optimizerWindow = await store.loadWindowForOptimizer("g1", "u1", null, 10);
    assert.deepEqual(
      optimizerWindow.map(({ role, content }) => ({ role, content })),
      [
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "second question" },
        { role: "assistant", content: "second answer" },
      ],
    );

    const optimizerWindowLimited = await store.loadWindowForOptimizer("g1", "u1", null, 3);
    assert.deepEqual(
      optimizerWindowLimited.map(({ role, content }) => ({ role, content })),
      [
        { role: "user", content: "second question" },
        { role: "assistant", content: "second answer" },
      ],
    );

    // Legacy jsonb string-scalar meta rows (where SQL meta->'r18' is NULL) must still be excluded
    // without shortening the returned optimizer window below maxRows.
    const legacyBase = Date.now() + 50;
    const legacyMeta = JSON.stringify({ r18: true, provider: "local_llm" });
    await pool.query(
      `INSERT INTO ai_history (id, guild_id, user_id, role, content, meta, created_at)
       VALUES ($1, $2, $3, 'user', 'legacy r18 q', to_jsonb($4::text), $5),
              ($6, $2, $3, 'assistant', 'legacy r18 a', to_jsonb($4::text), $7)`,
      [
        randomUUID(),
        "g1",
        "u1",
        legacyMeta,
        new Date(legacyBase),
        randomUUID(),
        new Date(legacyBase + 1),
      ],
    );
    const optimizerWindowWithLegacy = await store.loadWindowForOptimizer("g1", "u1", null, 4);
    assert.deepEqual(
      optimizerWindowWithLegacy.map(({ role, content }) => ({ role, content })),
      [
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "second question" },
        { role: "assistant", content: "second answer" },
      ],
    );

    // 30 recent legacy r18 string-scalar meta rows (exceeding a single fetchLimit page)
    // must be paginated past so older normal rows are still returned.
    const bulkLegacyBase = Date.now() + 200;
    for (let i = 0; i < 15; i += 1) {
      await pool.query(
        `INSERT INTO ai_history (id, guild_id, user_id, role, content, meta, created_at)
         VALUES ($1, $2, $3, 'user', $4, to_jsonb($5::text), $6),
                ($7, $2, $3, 'assistant', $8, to_jsonb($5::text), $9)`,
        [
          randomUUID(),
          "g1",
          "u1",
          `bulk legacy r18 q ${i}`,
          legacyMeta,
          new Date(bulkLegacyBase + i * 2),
          randomUUID(),
          `bulk legacy r18 a ${i}`,
          new Date(bulkLegacyBase + i * 2 + 1),
        ],
      );
    }
    const optimizerWindowPast30Legacy = await store.loadWindowForOptimizer("g1", "u1", null, 4);
    assert.deepEqual(
      optimizerWindowPast30Legacy.map(({ role, content }) => ({ role, content })),
      [
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "second question" },
        { role: "assistant", content: "second answer" },
      ],
    );

    await store.clear("g1", "u1");
    assert.equal(await store.countSince("g1", "u1", null, "normal"), 0);

    // Microsecond-precision cursor test across page boundary:
    // For maxRows = 4, fetchLimit = 14. Place 14 legacy r18 rows on page 1 ending at .000500Z,
    // and 2 normal rows in the SAME millisecond (.000100Z and .000200Z) on page 2.
    await pool.query(
      `INSERT INTO ai_history (id, guild_id, user_id, role, content, meta, created_at)
       VALUES ($1, $2, $3, 'user', 'micro q', '{"provider":"openai"}'::jsonb, '2026-01-01T00:00:00.000100Z'::timestamptz),
              ($4, $2, $3, 'assistant', 'micro a', '{"provider":"openai"}'::jsonb, '2026-01-01T00:00:00.000200Z'::timestamptz)`,
      [randomUUID(), "g1", "u_micro", randomUUID()],
    );
    for (let i = 0; i < 14; i += 1) {
      const micro = String(500 + i * 10).padStart(6, "0");
      await pool.query(
        `INSERT INTO ai_history (id, guild_id, user_id, role, content, meta, created_at)
         VALUES ($1, $2, $3, 'user', $4, to_jsonb($5::text), $6::timestamptz)`,
        [
          randomUUID(),
          "g1",
          "u_micro",
          `micro legacy ${i}`,
          legacyMeta,
          `2026-01-01T00:00:00.${micro}Z`,
        ],
      );
    }
    const microWindow = await store.loadWindowForOptimizer("g1", "u_micro", null, 4);
    assert.deepEqual(
      microWindow.map(({ role, content }) => ({ role, content })),
      [
        { role: "user", content: "micro q" },
        { role: "assistant", content: "micro a" },
      ],
    );
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${quotePgIdent(schemaName)} CASCADE`);
    await db.destroy();
  }
});

import assert from "node:assert/strict";
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

    await store.clear("g1", "u1");
    assert.equal(await store.countSince("g1", "u1", null, "normal"), 0);
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${quotePgIdent(schemaName)} CASCADE`);
    await db.destroy();
  }
});

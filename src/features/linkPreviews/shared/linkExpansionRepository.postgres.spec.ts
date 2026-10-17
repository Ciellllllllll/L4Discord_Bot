import assert from "node:assert/strict";
import { test } from "node:test";
import { createPgPool, quotePgIdent } from "../../../core/db/postgres.js";
import { getOptionalPostgresTestUrl } from "../../../test/postgresTestEnv.js";
import { ensurePostgresLinkExpansionSchema, LinkExpansionRepository } from "./linkExpansionRepository.js";

void test("PostgreSQL keeps durable expansion mappings for seven days, upserts responses and expires only records", async () => {
  const url = getOptionalPostgresTestUrl("TEST_DATABASE_URL", "linkExpansionRepository.postgres.spec.ts");
  if (!url) return;
  const schema = `expansion_test_${process.pid}_${Date.now()}`;
  const admin = await createPgPool(url);
  const pool = await createPgPool(url, schema);
  try {
    await ensurePostgresLinkExpansionSchema(pool);
    await ensurePostgresLinkExpansionSchema(pool);
    const repository = new LinkExpansionRepository(pool, () => "production-bot");
    const first = await repository.register({ id: "source", guildId: "guild", channelId: "channel" });
    assert.ok(first);
    assert.ok(Math.abs(first.expires_at.getTime() - Date.now() - 7 * 86_400_000) < 10_000);
    await repository.markRendered("source", "fingerprint-only-no-body");
    await repository.save({
      source_message_id: "source", expansion_key: "discord:0", response_message_id: "response",
      quoted_channel_id: "private-channel", quoted_message_id: "quote", quoted_hash: "old-hash",
    });
    await repository.save({
      source_message_id: "source", expansion_key: "discord:0", response_message_id: "response",
      quoted_channel_id: "new-private-channel", quoted_message_id: "new-quote", quoted_hash: "new-hash",
    });
    const restarted = new LinkExpansionRepository(pool, () => "production-bot");
    assert.equal((await restarted.records("source")).length, 1);
    assert.equal((await restarted.affected("quote")).length, 0);
    assert.equal((await restarted.affected("new-quote"))[0]?.message_id, "source");
    assert.equal((await restarted.affected("response")).length, 0, "own card edits must not start a loop");
    assert.equal((await restarted.affected("response", true)).length, 1);
    assert.equal(await restarted.wouldCycle("response", "new-quote"), false);
    assert.equal(await restarted.wouldCycle("response", "response"), true);
    await restarted.register({ id: "source-2", guildId: "guild", channelId: "channel" });
    await restarted.save({
      source_message_id: "source-2", expansion_key: "discord:0", response_message_id: "response-2",
      quoted_channel_id: "channel", quoted_message_id: "response", quoted_hash: "hash",
    });
    assert.equal(await restarted.wouldCycle("response", "response-2"), true);
    await restarted.forgetSource("source-2");
    assert.equal((await restarted.register({ id: "source", guildId: "guild", channelId: "channel" }))?.expires_at.getTime(), first.expires_at.getTime());
    assert.equal((await restarted.source("source"))?.content_hash, "fingerprint-only-no-body");
    assert.equal((await restarted.page())[0]?.message_id, "source");
    assert.deepEqual(await restarted.page("source"), []);
    const debug = new LinkExpansionRepository(pool, () => "debug-bot");
    assert.equal(await debug.source("source"), undefined);
    assert.deepEqual(await debug.affected("new-quote"), []);
    await debug.register({ id: "source", guildId: "guild", channelId: "channel" });
    await debug.save({
      source_message_id: "source", expansion_key: "discord:0", response_message_id: "debug-response",
      quoted_channel_id: "channel", quoted_message_id: "response", quoted_hash: "hash",
    });
    assert.equal(await restarted.wouldCycle("response", "debug-response"), true, "cycles can cross bot identities");
    await debug.markRendered("source", "debug-hash");
    await debug.forgetResponse("response");
    assert.equal((await restarted.records("source"))[0]?.response_message_id, "response");
    assert.equal((await restarted.source("source"))?.content_hash, "fingerprint-only-no-body");
    assert.equal((await debug.page()).length, 1);
    await pool.query("UPDATE link_expansion_sources SET expires_at = CURRENT_TIMESTAMP - interval '1 second' WHERE bot_id = 'production-bot'");
    assert.equal(await restarted.source("source"), undefined);
    assert.deepEqual(await restarted.affected("new-quote"), []);
    await restarted.cleanup();
    assert.equal((await pool.query("SELECT * FROM link_expansion_sources")).rowCount, 1);
    assert.equal((await pool.query("SELECT * FROM link_expansion_messages")).rowCount, 1);
    assert.equal((await debug.records("source"))[0]?.response_message_id, "debug-response");
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${quotePgIdent(schema)} CASCADE`);
    await admin.end();
  }
});

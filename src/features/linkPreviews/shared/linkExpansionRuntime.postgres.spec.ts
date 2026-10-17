import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BotContext } from "../../../bot/context.js";
import { registerRuntimeHandlers } from "../../../bot/registerRuntimeHandlers.js";
import { createPgPool, quotePgIdent } from "../../../core/db/postgres.js";
import { getOptionalPostgresTestUrl } from "../../../test/postgresTestEnv.js";
import { ensurePostgresLinkExpansionSchema, LinkExpansionRepository } from "./linkExpansionRepository.js";

void test("runtime synchronizes edits and bulk deletions outside GUILD_ID, including bot-authored quote targets", async () => {
  const url = getOptionalPostgresTestUrl("TEST_DATABASE_URL", "linkExpansionRuntime.postgres.spec.ts");
  if (!url) return;
  const schema = `expansion_runtime_${process.pid}_${Date.now()}`;
  const admin = await createPgPool(url);
  const pool = await createPgPool(url, schema);
  let runtime: Awaited<ReturnType<typeof registerRuntimeHandlers>> | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    await ensurePostgresLinkExpansionSchema(pool);
    const repository = new LinkExpansionRepository(pool, () => "bot");
    const deleted = new Set<string>();
    let complete!: () => void;
    const done = new Promise<void>((resolve) => { complete = resolve; });
    const messages = new Map<string, unknown>();
    const channel = {
      isTextBased: () => true, isDMBased: () => false,
      messages: { fetch: async ({ message: id }: { message: string }) => {
        if (!messages.has(id)) throw Object.assign(new Error("Unknown message"), { code: 10008 });
        return messages.get(id);
      } },
    };
    const client = Object.assign(new EventEmitter(), {
      user: { id: "bot" },
      channels: { fetch: async () => channel }, destroy: () => undefined,
    });
    for (const id of ["source-edit", "source-quote", "source-delete", "source-bulk"]) {
      const message = {
        id, guildId: "other-guild", channelId: "channel", guild: { id: "other-guild" },
        author: { id: "reader", bot: false }, content: "リンクを除去した本文", embeds: [], components: [], attachments: new Map(),
      };
      messages.set(id, message);
      messages.set(`response-${id}`, {
        delete: async () => {
          deleted.add(id);
          if (deleted.size === 4) complete();
        },
      });
      await repository.register(message);
      await repository.save({
        source_message_id: id, expansion_key: "discord:0", response_message_id: `response-${id}`,
        quoted_channel_id: id === "source-quote" ? "channel" : null,
        quoted_message_id: id === "source-quote" ? "bot-quote" : null, quoted_hash: "old-hash",
      });
    }
    messages.set("bot-quote", {
      id: "bot-quote", content: "変更されたBOTの投稿", embeds: [], components: [], attachments: new Map(),
    });
    const warn = (entry: unknown) => { throw new Error(`Unexpected runtime warning: ${JSON.stringify(entry)}`); };
    const ctx = {
      client, mainPgPool: pool, log: { debug() {}, info() {}, error: warn, warn }, vcTemp: { stopSweep() {} },
      config: {
        GUILD_ID: "main-guild", SENRYU_ENABLED: false, JAPANESE_WORKER_ENABLED: false,
        COLD_LAUGH_STORE_PATH: join(tmpdir(), `${schema}-unused.json`),
      },
    } as unknown as BotContext;
    runtime = await registerRuntimeHandlers(ctx);
    client.emit("messageUpdate", {}, { id: "source-edit", guildId: "other-guild", author: { bot: false } });
    client.emit("messageUpdate", {}, { id: "bot-quote", guildId: "quote-guild", author: { bot: true } });
    client.emit("messageDelete", { id: "source-delete", guildId: "other-guild" });
    client.emit("messageDeleteBulk", new Map([["source-bulk", { id: "source-bulk", guildId: "other-guild" }]]));
    await Promise.race([done, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Runtime event synchronization timed out")), 5000);
    })]);
    await runtime.shutdown();
    assert.deepEqual([...deleted].sort(), ["source-bulk", "source-delete", "source-edit", "source-quote"]);
    assert.equal((await pool.query("SELECT * FROM link_expansion_messages")).rowCount, 0);
    assert.equal((await pool.query("SELECT * FROM link_expansion_sources")).rowCount, 2);
  } finally {
    if (timer) clearTimeout(timer);
    await runtime?.shutdown();
    await pool.end();
    await admin.query(`DROP SCHEMA ${quotePgIdent(schema)} CASCADE`);
    await admin.end();
  }
});

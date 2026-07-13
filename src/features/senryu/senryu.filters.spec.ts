import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { ChannelType, type Message } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { createKysely } from "../../core/db/kysely.js";
import { getGuildSettingsData } from "../../core/guildSettings.js";
import { runSenryuPipeline } from "./senryu.service.js";
import { muteChannelForSenryuPersisted } from "./senryu.filters.js";
import type { SenryuRepository } from "./senryu.repository.js";
import type { SenryuRecord, SavedSenryuRecord } from "./senryu.types.js";

function makeDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE guild_settings (
      guild_id TEXT PRIMARY KEY NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      revision INTEGER NOT NULL DEFAULT 0
    );
  `);
  return createKysely(sqlite);
}

function makeMessage(channelId = "channel"): Message {
  return {
    id: "message",
    guildId: "guild",
    guild: { id: "guild" },
    channelId,
    channel: {
      id: channelId,
      type: ChannelType.GuildText,
      isThread: () => false,
    },
    author: {
      id: "author",
      bot: false,
    },
    content: "春風にコードが揺れてバグが咲く",
  } as unknown as Message;
}

function makeCtx(db: ReturnType<typeof makeDb>): BotContext {
  return {
    db,
    config: {
      GUILD_ID: "guild",
      SENRYU_ENABLED: true,
      SENRYU_MAX_CONTENT_LENGTH: 2000,
      SENRYU_DETECTOR_MODE: "go-worker",
      SENRYU_WORKER_FALLBACK_ENABLED: false,
      SENRYU_WORKER_FALLBACK_ON_NO_MATCH: false,
      SENRYU_MORA_TOLERANCE: 0,
      SENRYU_BEST_CANDIDATE: false,
      SENRYU_JS_HAIKU_VERIFY_ENABLED: true,
      SENRYU_AI_REVIEW_ENABLED: true,
      SENRYU_SAVE_ENABLED: false,
      SENRYU_REPLY_ENABLED: false,
      SENRYU_AUTO_MUTE_ON_PERMISSION_ERROR: true,
      JAPANESE_WORKER_ENABLED: true,
      JAPANESE_WORKER_URL: "http://127.0.0.1:8787",
      JAPANESE_WORKER_TIMEOUT_MS: 100,
    },
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  } as unknown as BotContext;
}

function makeRepo(): SenryuRepository {
  return {
    async saveSenryu(record: SenryuRecord): Promise<SavedSenryuRecord> {
      return { ...record, id: "saved" };
    },
    async deleteSenryu(): Promise<void> {},
  };
}

async function run(): Promise<void> {
  const db = makeDb();
  await muteChannelForSenryuPersisted(db, "guild", "channel");

  const settings = await getGuildSettingsData(db, "guild");
  assert.deepEqual(settings.senryu_muted_channel_ids, ["channel"]);

  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("fetch should not be called for muted channels");
  };
  try {
    const handled = await runSenryuPipeline(makeCtx(db), makeMessage(), makeRepo());
    assert.equal(handled, false);
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
    await db.destroy();
  }
}

void run()
  .then(() => {
    console.log("senryu.filters.spec.ts: all assertions passed");
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

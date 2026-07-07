import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { MessageFlags, type ChatInputCommandInteraction, type GuildMember } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { createKysely } from "../../core/db/kysely.js";
import { maybePromptAnonymousSurvey } from "./surveyGate.js";
import { ensureAnonymousSurveySchema } from "./surveyService.js";

function makeDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE interaction_sessions (
      id TEXT PRIMARY KEY NOT NULL,
      guild_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      action TEXT NOT NULL,
      payload TEXT NOT NULL,
      executor_user_id TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  ensureAnonymousSurveySchema(sqlite);
  return { sqlite, db: createKysely(sqlite) };
}

function makeCtx(db: ReturnType<typeof createKysely>): BotContext {
  return {
    db,
    config: {
      DB_DRIVER: "postgres",
      GUILD_ID: "guild",
      OWNER_ID: "owner",
      ADMIN_ROLE_ID: "admin-role",
    },
  } as unknown as BotContext;
}

function makeInteraction(replies: unknown[]): ChatInputCommandInteraction {
  return {
    commandName: "ping",
    guildId: "guild",
    channelId: "channel",
    user: { id: "user" },
    options: { data: [] },
    inGuild: () => true,
    reply: async (payload: unknown) => {
      replies.push(payload);
    },
  } as unknown as ChatInputCommandInteraction;
}

function makeAdminMember(): GuildMember {
  return {
    id: "user",
    guild: { ownerId: "other" },
    permissions: { has: () => true },
    roles: { cache: new Map() },
  } as unknown as GuildMember;
}

async function run(): Promise<void> {
  const { sqlite, db } = makeDb();
  try {
    const adminReplies: unknown[] = [];
    assert.equal(await maybePromptAnonymousSurvey(makeInteraction(adminReplies), makeCtx(db), makeAdminMember()), false);
    assert.equal(adminReplies.length, 0);

    const replies: Array<{ flags?: number; embeds?: unknown[]; components?: unknown[] }> = [];
    assert.equal(await maybePromptAnonymousSurvey(makeInteraction(replies), makeCtx(db), null), true);
    assert.equal(replies.length, 1);
    assert.equal(replies[0]?.flags, MessageFlags.Ephemeral);
    assert.equal(replies[0]?.embeds?.length, 1);
    assert.equal(replies[0]?.components?.length, 2);

    const sessions = sqlite.prepare("SELECT domain, action, executor_user_id FROM interaction_sessions").all();
    assert.deepEqual(sessions, [{ domain: "anonymousSurvey", action: "slashGate", executor_user_id: "user" }]);
  } finally {
    await db.destroy();
    sqlite.close();
  }
}

void run()
  .then(() => {
    console.log("surveyGate.spec.ts: all assertions passed");
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type { ButtonInteraction } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { createKysely } from "../../core/db/kysely.js";
import { handleAnonymousSurveyButton } from "./surveyHandlers.js";
import {
  createAnonymousSurveySession,
  ensureAnonymousSurveySchema,
} from "./surveyService.js";

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
      BOT_PROFILE: "debug",
      GUILD_ID: "guild",
      OWNER_ID: "owner",
      ADMIN_ROLE_ID: "admin-role",
    },
    log: {
      warn: () => undefined,
      info: () => undefined,
      error: () => undefined,
    },
  } as unknown as BotContext;
}

function makeButton(customId: string, replies: unknown[], userId = "user"): ButtonInteraction {
  return {
    customId,
    user: { id: userId },
    guild: { id: "guild" },
    channel: { id: "channel" },
    member: null,
    client: {},
    reply: async (payload: unknown) => {
      replies.push(payload);
    },
    deferReply: async () => undefined,
    editReply: async (payload: unknown) => {
      replies.push(payload);
    },
    followUp: async (payload: unknown) => {
      replies.push(payload);
    },
    showModal: async (payload: unknown) => {
      replies.push(payload);
    },
    update: async (payload: unknown) => {
      replies.push(payload);
    },
  } as unknown as ButtonInteraction;
}

async function run(): Promise<void> {
  {
    const { sqlite, db } = makeDb();
    try {
      const sessionId = await createAnonymousSurveySession(db, "guild", "user", {
        commandName: "unknown_command",
        guildId: "guild",
        channelId: "channel",
        userId: "user",
        options: [],
      });
      const replies: Array<{ content?: string; embeds?: unknown[]; components?: unknown[]; flags?: unknown }> = [];
      assert.equal(await handleAnonymousSurveyButton(makeButton(`anon_survey:rating:${sessionId}:4`, replies), makeCtx(db)), true);
      const session = sqlite.prepare("SELECT payload FROM interaction_sessions WHERE id = ?").get(sessionId) as { payload: string };
      assert.equal(JSON.parse(session.payload).selectedRating, undefined);

      assert.equal(await handleAnonymousSurveyButton(makeButton(`anon_survey:submit:${sessionId}:4`, replies), makeCtx(db)), true);
      assert.equal(await handleAnonymousSurveyButton(makeButton(`anon_survey:submit:${sessionId}:4`, replies), makeCtx(db)), true);
      assert.equal(replies[1]?.content, undefined);
      assert.deepEqual(replies[1]?.embeds, []);
      assert.equal(Array.isArray(replies[1]?.components), true);
      assert.equal(replies.some((reply) => reply.content === "この機能は準備中です。"), true);
      assert.equal(replies.at(-1)?.content, "期限切れのため、もう一度コマンドを実行してください。");
      const responses = sqlite.prepare("SELECT guild_id, rating FROM anonymous_survey_responses").all();
      assert.deepEqual(responses, [{ guild_id: "guild", rating: 4 }]);
      const sessions = sqlite.prepare("SELECT * FROM interaction_sessions").all();
      assert.equal(sessions.length, 0);
    } finally {
      await db.destroy();
      sqlite.close();
    }
  }

  {
    const { sqlite, db } = makeDb();
    try {
      const sessionId = await createAnonymousSurveySession(db, "guild", "user", {
        commandName: "unknown_command",
        guildId: "guild",
        channelId: "channel",
        userId: "user",
        options: [],
      });
      const replies: Array<{ content?: string; embeds?: unknown[]; components?: unknown[] }> = [];
      assert.equal(await handleAnonymousSurveyButton(makeButton(`anon_survey:skip:${sessionId}`, replies), makeCtx(db)), true);
      assert.equal(replies[0]?.content, undefined);
      assert.deepEqual(replies[0]?.embeds, []);
      assert.equal(Array.isArray(replies[0]?.components), true);
      assert.equal(replies.at(-1)?.content, "この機能は準備中です。");
      const responses = sqlite.prepare("SELECT * FROM anonymous_survey_responses").all();
      assert.equal(responses.length, 0);
      const state = sqlite.prepare("SELECT last_action FROM anonymous_survey_user_state").all();
      assert.deepEqual(state, [{ last_action: "skip" }]);
    } finally {
      await db.destroy();
      sqlite.close();
    }
  }

  {
    const { sqlite, db } = makeDb();
    try {
      const sessionId = await createAnonymousSurveySession(db, "guild", "user", {
        commandName: "unknown_command",
        guildId: "guild",
        channelId: "channel",
        userId: "user",
        options: [],
      });
      const replies: Array<{ content?: string }> = [];
      assert.equal(await handleAnonymousSurveyButton(makeButton(`anon_survey:skip:${sessionId}`, replies, "other"), makeCtx(db)), true);
      assert.equal(replies.at(-1)?.content, "このアンケートは実行したユーザーのみ操作できます。");
      const sessions = sqlite.prepare("SELECT * FROM interaction_sessions").all();
      assert.equal(sessions.length, 1);
    } finally {
      await db.destroy();
      sqlite.close();
    }
  }

  {
    const { sqlite, db } = makeDb();
    try {
      const sessionId = await createAnonymousSurveySession(db, "guild", "user", {
        commandName: "survey",
        guildId: "guild",
        channelId: "channel",
        userId: "user",
        options: [],
      });
      const replies: Array<{ content?: string; embeds?: unknown[]; components?: unknown[] }> = [];
      assert.equal(await handleAnonymousSurveyButton(makeButton(`anon_survey:submit:${sessionId}:5`, replies), makeCtx(db)), true);
      assert.equal(replies.length, 1);
      assert.equal(replies[0]?.content, undefined);
      assert.deepEqual(replies[0]?.embeds, []);
      assert.equal(Array.isArray(replies[0]?.components), true);
      const responses = sqlite.prepare("SELECT guild_id, rating FROM anonymous_survey_responses").all();
      assert.deepEqual(responses, [{ guild_id: "guild", rating: 5 }]);
      const sessions = sqlite.prepare("SELECT * FROM interaction_sessions").all();
      assert.equal(sessions.length, 0);
    } finally {
      await db.destroy();
      sqlite.close();
    }
  }

  {
    const { sqlite, db } = makeDb();
    try {
      const sessionId = await createAnonymousSurveySession(db, "guild", "user", {
        commandName: "survey",
        guildId: "guild",
        channelId: "channel",
        userId: "user",
        options: [],
      });
      const replies: Array<{ content?: string; embeds?: unknown[]; components?: unknown[] }> = [];
      assert.equal(await handleAnonymousSurveyButton(makeButton(`anon_survey:skip:${sessionId}`, replies), makeCtx(db)), true);
      assert.equal(replies.length, 1);
      assert.equal(replies[0]?.content, undefined);
      assert.deepEqual(replies[0]?.embeds, []);
      assert.equal(Array.isArray(replies[0]?.components), true);
      const responses = sqlite.prepare("SELECT * FROM anonymous_survey_responses").all();
      assert.equal(responses.length, 0);
      const state = sqlite.prepare("SELECT last_action FROM anonymous_survey_user_state").all();
      assert.deepEqual(state, [{ last_action: "skip" }]);
    } finally {
      await db.destroy();
      sqlite.close();
    }
  }
}

void run()
  .then(() => {
    console.log("surveyHandlers.spec.ts: all assertions passed");
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import type { Insertable, Kysely } from "kysely";
import type { BotContext } from "../bot/context.js";
import { createKysely } from "../core/db/kysely.js";
import type { Database as AppDatabase } from "../core/db/types.js";
import { ensureAiR18UserSettingsSchema } from "../features/ai/aiR18UserSettingsSchema.js";
import { buildSlashCommands } from "./buildSlashCommands.js";
import { handleSlashCommand } from "./slashHandlers.js";

type ReplyPayload = {
  content?: string;
  flags?: number;
};

function makeDb(): { sqlite: Database.Database; db: Kysely<AppDatabase> } {
  const sqlite = new Database(":memory:");
  ensureAiR18UserSettingsSchema(sqlite);
  return { sqlite, db: createKysely(sqlite) };
}

function makeCtx(db: Kysely<AppDatabase>, guildId = "guild"): BotContext {
  return {
    db,
    config: {
      GUILD_ID: guildId,
      BOT_PROFILE: "debug",
      BOT_VERSION: "0.0.0",
    },
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  } as unknown as BotContext;
}

function makeInteraction(input: {
  guildId: string | null;
  userId?: string;
  enabled?: boolean;
}): { interaction: ChatInputCommandInteraction; replies: ReplyPayload[] } {
  const replies: ReplyPayload[] = [];
  const interaction = {
    commandName: "r18",
    guildId: input.guildId,
    user: { id: input.userId ?? "user" },
    inGuild: () => input.guildId !== null,
    options: {
      getBoolean: (name: string, required?: boolean) => {
        assert.equal(name, "enabled");
        assert.equal(required, true);
        return input.enabled ?? true;
      },
    },
    reply: async (payload: ReplyPayload) => {
      replies.push(payload);
    },
  } as unknown as ChatInputCommandInteraction;
  return { interaction, replies };
}

async function readR18Setting(db: Kysely<AppDatabase>, guildId = "guild", userId = "user") {
  return db
    .selectFrom("ai_r18_user_settings")
    .selectAll()
    .where("guild_id", "=", guildId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
}

async function countR18SettingsForUser(db: Kysely<AppDatabase>, userId: string) {
  const row = await db
    .selectFrom("ai_r18_user_settings")
    .select(({ fn }) => fn.countAll<number>().as("count"))
    .where("user_id", "=", userId)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

async function run(): Promise<void> {
  const r18 = buildSlashCommands().find((command) => command.name === "r18");
  assert.ok(r18);
  assert.ok("description" in r18);
  assert.equal(r18.description, "自分のR18モードを切り替えます");
  assert.equal(r18.options?.length, 1);
  assert.equal(r18.options?.[0]?.name, "enabled");
  assert.equal(r18.options?.[0]?.required, true);

  const { sqlite, db } = makeDb();
  try {
    const ctx = makeCtx(db);
    const { interaction, replies } = makeInteraction({ guildId: "guild", enabled: true });
    await handleSlashCommand(interaction, ctx, { skipSurvey: true });

    const row = await readR18Setting(db);
    assert.equal(row?.enabled, 1);
    assert.match(row?.updated_at ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(replies.length, 1);
    assert.equal(replies[0]?.flags, MessageFlags.Ephemeral);

    await db
      .insertInto("ai_r18_user_settings")
      .values({
        guild_id: "guild",
        user_id: "other-user",
        enabled: 1,
        updated_at: "2026-01-01T00:00:00.000Z",
      } satisfies Insertable<AppDatabase["ai_r18_user_settings"]>)
      .execute();

    const { interaction: offInteraction } = makeInteraction({ guildId: "guild", enabled: false });
    await handleSlashCommand(offInteraction, ctx, { skipSurvey: true });
    const ownRow = await readR18Setting(db);
    const otherRow = await readR18Setting(db, "guild", "other-user");
    assert.equal(ownRow?.enabled, 0);
    assert.equal(otherRow?.enabled, 1);

    const { interaction: dmInteraction, replies: dmReplies } = makeInteraction({ guildId: null, enabled: true });
    await handleSlashCommand(dmInteraction, ctx, { skipSurvey: true });
    assert.equal(dmReplies.length, 1);
    assert.equal(dmReplies[0]?.flags, MessageFlags.Ephemeral);

    const { interaction: otherGuildInteraction, replies: otherGuildReplies } = makeInteraction({
      guildId: "other-guild",
      userId: "outside-user",
      enabled: true,
    });
    await handleSlashCommand(otherGuildInteraction, ctx, { skipSurvey: true });
    assert.equal(otherGuildReplies.length, 1);
    assert.equal(otherGuildReplies[0]?.flags, MessageFlags.Ephemeral);
    assert.equal(await countR18SettingsForUser(db, "outside-user"), 0);
  } finally {
    await db.destroy();
    sqlite.close();
  }
}

void run()
  .then(() => {
    console.log("r18Command.spec.ts: all assertions passed");
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

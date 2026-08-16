import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type GuildMember,
} from "discord.js";
import type { BotContext } from "../bot/context.js";
import { createKysely } from "../core/db/kysely.js";
import { getGuildSettingsData, upsertGuildSettingsData } from "../core/guildSettings.js";
import { BOT_SEMVER, SLASH_COMMAND_MIN_BOT_VERSION } from "../core/releaseVersions.js";
import { handleSlashCommand } from "./slashHandlers.js";

const TRIGGER_URL = "https://tenor.com/view/trigger-gif-123";
const RESPONSE_URL = "https://tenor.com/view/response-gif-456";

function member(admin: boolean): GuildMember {
  return {
    id: "user",
    guild: { ownerId: "owner" },
    permissions: { has: (permission: bigint) => admin && permission === PermissionFlagsBits.Administrator },
    roles: { cache: { has: () => false } },
  } as unknown as GuildMember;
}

function interaction(
  subcommand: "set" | "show" | "clear",
  replies: unknown[],
  options: { admin?: boolean; triggerUrl?: string; responseUrl?: string } = {},
): ChatInputCommandInteraction {
  const values: Record<string, string | undefined> = {
    trigger_url: options.triggerUrl,
    response_url: options.responseUrl,
  };
  return {
    commandName: "gif",
    guildId: "guild",
    user: { id: "user" },
    member: member(options.admin ?? true),
    inGuild: () => true,
    options: {
      getSubcommand: () => subcommand,
      getString: (name: string) => values[name] ?? null,
    },
    reply: async (payload: unknown) => { replies.push(payload); return {} as never; },
  } as unknown as ChatInputCommandInteraction;
}

async function run(): Promise<void> {
  assert.equal(BOT_SEMVER, "2.0.14");
  assert.equal(SLASH_COMMAND_MIN_BOT_VERSION.gif, "2.0.14");

  const sqlite = new Database(":memory:");
  sqlite.exec("CREATE TABLE guild_settings (guild_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0)");
  const db = createKysely(sqlite);
  const ctx = {
    config: {
      BOT_PROFILE: "debug",
      GUILD_ID: "guild",
      OWNER_ID: "owner",
      ADMIN_ROLE_ID: "admin-role",
    },
    db,
    log: { warn: () => undefined, info: () => undefined },
  } as unknown as BotContext;

  try {
    const deniedReplies: unknown[] = [];
    await handleSlashCommand(interaction("set", deniedReplies, {
      admin: false,
      triggerUrl: TRIGGER_URL,
      responseUrl: RESPONSE_URL,
    }), ctx, { skipSurvey: true });
    assert.deepEqual(await getGuildSettingsData(db, "guild"), {});
    assert.deepEqual(deniedReplies, [{ content: "権限がありません。", flags: MessageFlags.Ephemeral }]);

    const invalidReplies: unknown[] = [];
    await handleSlashCommand(interaction("set", invalidReplies, {
      triggerUrl: "ftp://example.com/trigger.gif",
      responseUrl: RESPONSE_URL,
    }), ctx, { skipSurvey: true });
    assert.deepEqual(await getGuildSettingsData(db, "guild"), {});
    assert.match((invalidReplies[0] as { content: string }).content, /HTTP\(S\)/);

    const correctedUrlReplies: unknown[] = [];
    await handleSlashCommand(interaction("set", correctedUrlReplies, {
      triggerUrl: "https:example.com/trigger.gif",
      responseUrl: RESPONSE_URL,
    }), ctx, { skipSurvey: true });
    assert.deepEqual(await getGuildSettingsData(db, "guild"), {});
    assert.match((correctedUrlReplies[0] as { content: string }).content, /HTTP\(S\)/);

    const controlCharacterReplies: unknown[] = [];
    await handleSlashCommand(interaction("set", controlCharacterReplies, {
      triggerUrl: "https://example.com/trigger\n.gif",
      responseUrl: RESPONSE_URL,
    }), ctx, { skipSurvey: true });
    assert.deepEqual(await getGuildSettingsData(db, "guild"), {});
    assert.match((controlCharacterReplies[0] as { content: string }).content, /HTTP\(S\)/);

    const edgeControlCharacterReplies: unknown[] = [];
    await handleSlashCommand(interaction("set", edgeControlCharacterReplies, {
      triggerUrl: `\thttps://example.com/trigger.gif`,
      responseUrl: RESPONSE_URL,
    }), ctx, { skipSurvey: true });
    assert.deepEqual(await getGuildSettingsData(db, "guild"), {});
    assert.match((edgeControlCharacterReplies[0] as { content: string }).content, /HTTP\(S\)/);

    const tooLongReplies: unknown[] = [];
    await handleSlashCommand(interaction("set", tooLongReplies, {
      triggerUrl: `https://example.com/${"x".repeat(901)}`,
      responseUrl: RESPONSE_URL,
    }), ctx, { skipSurvey: true });
    assert.deepEqual(await getGuildSettingsData(db, "guild"), {});
    assert.match((tooLongReplies[0] as { content: string }).content, /900文字以内/);

    const setReplies: unknown[] = [];
    await handleSlashCommand(interaction("set", setReplies, {
      triggerUrl: TRIGGER_URL,
      responseUrl: RESPONSE_URL,
    }), ctx, { skipSurvey: true });
    assert.deepEqual((await getGuildSettingsData(db, "guild")).gif_auto_reply, {
      trigger_url: TRIGGER_URL,
      response_url: RESPONSE_URL,
    });
    assert.equal((setReplies[0] as { flags: MessageFlags }).flags, MessageFlags.Ephemeral);

    const showReplies: unknown[] = [];
    await handleSlashCommand(interaction("show", showReplies), ctx, { skipSurvey: true });
    const shown = showReplies[0] as { content: string; flags: MessageFlags; allowedMentions: { parse: [] } };
    assert.equal(shown.flags, MessageFlags.Ephemeral);
    assert.match(shown.content, new RegExp(TRIGGER_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(shown.content, new RegExp(RESPONSE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.deepEqual(shown.allowedMentions, { parse: [] });

    const clearReplies: unknown[] = [];
    await handleSlashCommand(interaction("clear", clearReplies), ctx, { skipSurvey: true });
    assert.equal((await getGuildSettingsData(db, "guild")).gif_auto_reply, undefined);
    assert.equal((clearReplies[0] as { flags: MessageFlags }).flags, MessageFlags.Ephemeral);

    const emptyReplies: unknown[] = [];
    await handleSlashCommand(interaction("show", emptyReplies), ctx, { skipSurvey: true });
    assert.match((emptyReplies[0] as { content: string }).content, /設定されていません/);

    await upsertGuildSettingsData(db, "guild", {
      gif_auto_reply: { trigger_url: TRIGGER_URL, response_url: `https://example.com/${"x".repeat(901)}` },
    });
    const malformedReplies: unknown[] = [];
    await handleSlashCommand(interaction("show", malformedReplies), ctx, { skipSurvey: true });
    assert.match((malformedReplies[0] as { content: string }).content, /設定されていません/);

    const oldVersionReplies: unknown[] = [];
    await handleSlashCommand(interaction("show", oldVersionReplies), {
      ...ctx,
      config: { ...ctx.config, BOT_PROFILE: "production", BOT_VERSION: "2.0.13" },
    } as BotContext, { skipSurvey: true });
    assert.equal((oldVersionReplies[0] as { content: string }).content, "現在のVerではそのコマンドは使用できません！");

    const currentVersionReplies: unknown[] = [];
    await handleSlashCommand(interaction("show", currentVersionReplies), {
      ...ctx,
      config: { ...ctx.config, BOT_PROFILE: "production", BOT_VERSION: "2.0.14" },
    } as BotContext, { skipSurvey: true });
    assert.equal((currentVersionReplies[0] as { flags: MessageFlags }).flags, MessageFlags.Ephemeral);
  } finally {
    await db.destroy();
  }
}

run()
  .then(() => console.log("gifCommand.spec.ts: all assertions passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

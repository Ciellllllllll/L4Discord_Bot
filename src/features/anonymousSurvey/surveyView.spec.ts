import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { MessageFlags, PermissionFlagsBits, type ButtonInteraction, type ChatInputCommandInteraction, type GuildMember } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { createKysely } from "../../core/db/kysely.js";
import { ensureAnonymousSurveySchema } from "./surveyService.js";
import {
  ANONYMOUS_SURVEY_VIEW_PAGE_SIZE,
  buildAnonymousSurveyViewMessage,
  getAnonymousSurveyView,
  handleAnonymousSurveyViewButton,
  handleAnonymousSurveyViewCommand,
} from "./surveyView.js";

function makeDb() {
  const sqlite = new Database(":memory:");
  ensureAnonymousSurveySchema(sqlite);
  return { sqlite, db: createKysely(sqlite) };
}

function seed(sqlite: Database.Database, guildId: string, count: number): void {
  const insert = sqlite.prepare("INSERT INTO anonymous_survey_responses (id, guild_id, rating, created_at) VALUES (?, ?, ?, ?)");
  for (let index = 0; index < count; index += 1) {
    insert.run(`${guildId}-${index}`, guildId, (index % 5) + 1, new Date(Date.UTC(2026, 6, 1, 0, index, 0)).toISOString());
  }
}

function makeCtx(db: ReturnType<typeof createKysely>): BotContext {
  return {
    db,
    config: { GUILD_ID: "guild", OWNER_ID: "owner", ADMIN_ROLE_ID: "admin-role" },
  } as unknown as BotContext;
}

function member(admin: boolean): GuildMember {
  return {
    id: admin ? "admin" : "user",
    guild: { ownerId: "owner" },
    permissions: { has: (permission: bigint) => admin && permission === PermissionFlagsBits.Administrator },
    roles: { cache: new Map() },
  } as unknown as GuildMember;
}

function commandInteraction(replies: unknown[]): ChatInputCommandInteraction {
  return {
    guildId: "guild",
    inGuild: () => true,
    reply: async (payload: unknown) => { replies.push(payload); },
  } as unknown as ChatInputCommandInteraction;
}

function buttonInteraction(customId: string, replies: unknown[], updates: unknown[], admin: boolean): ButtonInteraction {
  return {
    customId,
    guildId: "guild",
    inGuild: () => true,
    member: member(admin),
    reply: async (payload: unknown) => { replies.push(payload); },
    update: async (payload: unknown) => { updates.push(payload); },
  } as unknown as ButtonInteraction;
}

async function run(): Promise<void> {
  const { sqlite, db } = makeDb();
  try {
    seed(sqlite, "guild", 21);
    seed(sqlite, "other-guild", 3);

    const first = await getAnonymousSurveyView(db, "guild", 0);
    assert.equal(ANONYMOUS_SURVEY_VIEW_PAGE_SIZE, 20);
    assert.equal(first.totalResponses, 21);
    assert.equal(first.responses.length, 20);
    assert.equal(first.responses[0]?.createdAt, "2026-07-01T00:20:00.000Z");
    assert.deepEqual(first.ratingCounts, [5, 4, 4, 4, 4]);
    assert.equal(first.page, 0);
    assert.equal(first.totalPages, 2);

    const last = await getAnonymousSurveyView(db, "guild", 99);
    assert.equal(last.page, 1);
    assert.equal(last.responses.length, 1);

    const payload = buildAnonymousSurveyViewMessage(first);
    assert.equal(payload.flags, MessageFlags.IsComponentsV2);
    assert.equal(payload.embeds.length, 0);
    assert.equal(payload.components[0]?.type, 17);
    const rows = (payload.components[0] as { components: Array<{ components?: Array<{ custom_id?: string; disabled?: boolean }> }> }).components;
    const buttons = rows.flatMap((component) => component.components ?? []);
    assert.equal(buttons[0]?.disabled, true);
    assert.equal(buttons[1]?.custom_id, "anon_survey:view:1");

    seed(sqlite, "single-guild", 1);
    const singlePayload = buildAnonymousSurveyViewMessage(await getAnonymousSurveyView(db, "single-guild", 0));
    const singleRows = (singlePayload.components[0] as { components: Array<{ components?: Array<{ disabled?: boolean }> }> }).components;
    const singleButtons = singleRows.flatMap((component) => component.components ?? []);
    assert.deepEqual(singleButtons.map((button) => button.disabled), [true, true]);

    const emptyPayload = buildAnonymousSurveyViewMessage(await getAnonymousSurveyView(db, "empty-guild", 0));
    const emptyRows = (emptyPayload.components[0] as { components: Array<{ components?: Array<unknown> }> }).components;
    assert.equal(emptyRows.flatMap((component) => component.components ?? []).length, 0);

    const lastPayload = buildAnonymousSurveyViewMessage(last);
    const lastRows = (lastPayload.components[0] as { components: Array<{ components?: Array<{ disabled?: boolean }> }> }).components;
    const lastButtons = lastRows.flatMap((component) => component.components ?? []);
    assert.deepEqual(lastButtons.map((button) => button.disabled), [false, true]);
    assert.equal(JSON.stringify(payload.components).includes("guild"), false);

    assert.equal(await handleAnonymousSurveyViewButton(buttonInteraction("anon_survey:view:not-a-page", [], [], true), makeCtx(db)), false);

    const replies: Array<{ flags?: unknown; embeds?: unknown[]; components?: unknown[] }> = [];
    await handleAnonymousSurveyViewCommand(commandInteraction(replies), makeCtx(db), member(true));
    assert.deepEqual(replies[0]?.flags, [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]);
    assert.equal(replies[0]?.embeds?.length, 0);

    const deniedReplies: Array<{ flags?: unknown }> = [];
    await handleAnonymousSurveyViewCommand(commandInteraction(deniedReplies), makeCtx(db), member(false));
    assert.deepEqual(deniedReplies[0]?.flags, [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]);

    const buttonReplies: unknown[] = [];
    const updates: Array<{ components?: unknown[] }> = [];
    assert.equal(await handleAnonymousSurveyViewButton(buttonInteraction("anon_survey:view:1", buttonReplies, updates, true), makeCtx(db)), true);
    assert.equal(updates.length, 1);

    const deniedButtonReplies: Array<{ flags?: unknown }> = [];
    assert.equal(await handleAnonymousSurveyViewButton(buttonInteraction("anon_survey:view:1", deniedButtonReplies, [], false), makeCtx(db)), true);
    assert.deepEqual(deniedButtonReplies[0]?.flags, [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]);
  } finally {
    await db.destroy();
    sqlite.close();
  }
}

void run()
  .then(() => { console.log("surveyView.spec.ts: all assertions passed"); })
  .catch((error) => { console.error(error); process.exit(1); });

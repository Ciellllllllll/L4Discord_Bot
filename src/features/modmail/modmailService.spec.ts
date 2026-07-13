import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelType, type Guild } from "discord.js";
import Database from "better-sqlite3";
import type { BotContext } from "../../bot/context.js";
import { createTicketKysely } from "../../core/db/kysely.js";
import { ensureTicketDatabaseSchema } from "../tickets/ticketDbSchema.js";
import { createStaffThread, createTicketFromIntakeForm, deleteModmailSkeletonBestEffort, type ModmailThreadRow } from "./modmailService.js";

const row: ModmailThreadRow = {
  id: "ticket-id",
  guild_id: "guild",
  user_id: "user",
  channel_id: null,
  thread_id: null,
  status: "open",
  data: {},
  created_at: new Date("2026-07-12T00:00:00.000Z"),
};

function context(warnings: unknown[][]): BotContext {
  return {
    config: { MOD_LOG_CHANNEL_ID: "parent" },
    log: { warn: (...args: unknown[]) => { warnings.push(args); } },
  } as unknown as BotContext;
}

test("text modmail thread is deleted when its summary message fails", async () => {
  let deleted = false;
  const thread = { id: "thread", isTextBased: () => true, send: async () => null, delete: async () => { deleted = true; } };
  const seed = { startThread: async () => thread, delete: async () => undefined };
  const parent = { type: ChannelType.GuildText, isTextBased: () => true, send: async () => seed };
  const guild = { channels: { cache: new Map([["parent", parent]]) } } as unknown as Guild;
  assert.equal(await createStaffThread(context([]), guild, row), null);
  assert.equal(deleted, true);
});

test("forum modmail thread is deleted when its starter message cannot be restored", async () => {
  let deleted = false;
  const thread = { id: "thread", isTextBased: () => true, fetchStarterMessage: async () => null, delete: async () => { deleted = true; } };
  const parent = { type: ChannelType.GuildForum, threads: { create: async () => thread } };
  const guild = { channels: { cache: new Map([["parent", parent]]) } } as unknown as Guild;
  assert.equal(await createStaffThread(context([]), guild, row), null);
  assert.equal(deleted, true);
});

test("modmail compensation deletion failures include the thread id in logs", async () => {
  const warnings: unknown[][] = [];
  const thread = { id: "thread", isTextBased: () => true, fetchStarterMessage: async () => null, delete: async () => { throw new Error("delete failed"); } };
  const parent = { type: ChannelType.GuildForum, threads: { create: async () => thread } };
  const guild = { channels: { cache: new Map([["parent", parent]]) } } as unknown as Guild;
  await createStaffThread(context(warnings), guild, row);
  assert.equal((warnings[0]?.[0] as { threadId?: string }).threadId, "thread");
});

test("ticket creation deletes its Discord thread and DB skeleton when metadata persistence fails", async () => {
  const sqlite = new Database(":memory:");
  ensureTicketDatabaseSchema(sqlite);
  sqlite.prepare("INSERT INTO modmail_intakes (guild_id, user_id, status, requested_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run("guild", "user", "PendingFirstMessage", "now", "now");
  sqlite.exec("CREATE TRIGGER fail_modmail_update BEFORE UPDATE ON modmail_threads BEGIN SELECT RAISE(ABORT, 'metadata update failed'); END");
  const ticketDb = createTicketKysely(sqlite);
  let deleted = false;
  const cache = new Map<string, unknown>();
  const thread = {
    id: "thread",
    isTextBased: () => true,
    isThread: () => true,
    fetchStarterMessage: async () => ({ id: "starter" }),
    delete: async () => { deleted = true; },
  };
  const parent = {
    type: ChannelType.GuildForum,
    threads: { create: async () => { cache.set("thread", thread); return thread; } },
  };
  cache.set("parent", parent);
  const guild = { channels: { cache, fetch: async (id: string) => cache.get(id) ?? null } } as unknown as Guild;
  const ctx = {
    ticketDb,
    config: { MOD_LOG_CHANNEL_ID: "parent" },
    client: { guilds: { fetch: async () => guild } },
    log: { warn: () => undefined },
  } as unknown as BotContext;
  try {
    const result = await createTicketFromIntakeForm(ctx, { guildId: "guild", userId: "user", title: "title", body: "body", attachments: [] });
    assert.equal(result.ok, false);
    assert.equal(deleted, true);
    assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM modmail_threads").get() as { count: number }).count, 0);
  } finally {
    await ticketDb.destroy();
  }
});

test("DB skeleton compensation deletion failures are logged without throwing", async () => {
  const warnings: unknown[][] = [];
  const ctx = {
    ticketDb: { deleteFrom: () => { throw new Error("delete failed"); } },
    log: { warn: (...args: unknown[]) => { warnings.push(args); } },
  } as unknown as BotContext;
  await deleteModmailSkeletonBestEffort(ctx, "modmail", "thread");
  assert.equal((warnings[0]?.[0] as { modmailId?: string }).modmailId, "modmail");
  assert.equal((warnings[0]?.[0] as { threadId?: string }).threadId, "thread");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { syncGuildApplicationCommands } from "./syncCommands.js";

test("skipped slash command synchronization emits a concise info summary", async () => {
  const entries: Array<{ bindings?: Record<string, unknown>; message?: string }> = [];
  const log = {
    info: (bindings: Record<string, unknown>, message: string) => entries.push({ bindings, message }),
    debug: () => undefined,
    error: () => undefined,
  };
  const config = {
    BOT_PROFILE: "debug",
    SKIP_COMMAND_SYNC: true,
    DISCORD_TOKEN: "token",
    DISCORD_CLIENT_ID: "client",
    GUILD_ID: "guild",
  };

  await syncGuildApplicationCommands(config as never, log as never);

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.message, "Slash command synchronization skipped.");
  assert.deepEqual(entries[0]?.bindings, { commandCount: 34, guildId: "guild", reason: "SKIP_COMMAND_SYNC" });
});

test("successful slash command synchronization emits one concise info summary", async () => {
  const entries: Array<{ bindings?: Record<string, unknown>; message?: string }> = [];
  const log = {
    info: (bindings: Record<string, unknown>, message: string) => entries.push({ bindings, message }),
    debug: () => undefined,
    error: () => undefined,
  };
  const config = {
    BOT_PROFILE: "debug",
    SKIP_COMMAND_SYNC: false,
    DISCORD_TOKEN: "token",
    DISCORD_CLIENT_ID: "client",
    GUILD_ID: "guild",
  };
  const calls: Array<{ route: string; body: unknown }> = [];

  await syncGuildApplicationCommands(config as never, log as never, {
    createRest: () => ({
      put: async (route: string, options: { body: unknown }) => { calls.push({ route, body: options.body }); },
    }) as never,
  });

  assert.equal(calls.length, 1);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.message, "Slash commands synchronized successfully.");
  assert.deepEqual(entries[0]?.bindings, { commandCount: 34, guildId: "guild" });
});

test("failed slash command synchronization logs the guild and command count", async () => {
  const errors: Array<{ bindings?: Record<string, unknown>; message?: string }> = [];
  const failure = new Error("Discord unavailable");
  const log = {
    info: () => undefined,
    debug: () => undefined,
    error: (bindings: Record<string, unknown>, message: string) => errors.push({ bindings, message }),
  };
  const config = {
    BOT_PROFILE: "debug",
    SKIP_COMMAND_SYNC: false,
    DISCORD_TOKEN: "token",
    DISCORD_CLIENT_ID: "client",
    GUILD_ID: "guild",
  };

  await syncGuildApplicationCommands(config as never, log as never, {
    createRest: () => ({ put: async () => { throw failure; } }) as never,
  });

  assert.deepEqual(errors, [{
    bindings: { commandCount: 34, err: failure, guildId: "guild" },
    message: "guild slash command sync failed",
  }]);
});

console.log("syncCommands.spec.ts: all assertions passed");

import assert from "node:assert/strict";
import { test } from "node:test";
import { ButtonStyle, ComponentType } from "discord.js";
import { routeButton } from "./handleComponents.js";

test("button routing gives a legacy id backed by common v1 state to the common handler first", async () => {
  const now = new Date();
  const row = {
    message_id: "message-1",
    guild_id: "guild-1",
    channel_id: "channel-1",
    source_kind: "youtube",
    source_url: "https://www.youtube.com/watch?v=abcdefghijk",
    document: {
      version: 1,
      source: "youtube",
      url: "https://www.youtube.com/watch?v=abcdefghijk",
      openLabel: "YouTubeで開く",
      blocks: [{ type: "text", id: "summary", lines: [{ parts: [{ text: "Hello", translationKey: "title" }] }] }],
    },
    translations: {
      version: 1,
      source: "youtube",
      model: "test-model",
      translations: {
        title: { shouldTranslate: true, sourceLanguage: "en", confidence: 0.9, translatedText: "こんにちは" },
      },
    },
    expires_at: new Date(now.getTime() + 60_000),
    created_at: now,
    updated_at: now,
  };
  const db = {
    selectFrom(table: string) {
      assert.equal(table, "preview_translation_states");
      const query = {
        selectAll: () => query,
        where: () => query,
        executeTakeFirst: async () => row,
      };
      return query;
    },
  };
  const calls: string[] = [];
  const interaction = {
    customId: "vxpreview:show-original",
    guildId: "guild-1",
    channelId: "channel-1",
    deferred: false,
    replied: false,
    message: {
      id: "message-1",
      author: { id: "bot-1" },
      components: [{
        toJSON: () => ({
          type: ComponentType.Container,
          components: [
            { type: ComponentType.TextDisplay, id: 2_140_000_000, content: "こんにちは" },
            {
              type: ComponentType.ActionRow,
              components: [
                { type: ComponentType.Button, style: ButtonStyle.Link, label: "YouTubeで開く", url: row.source_url },
                { type: ComponentType.Button, style: ButtonStyle.Secondary, label: "原文を表示", custom_id: "vxpreview:show-original" },
              ],
            },
          ],
        }),
      }],
      async fetch() { return this; },
    },
    async deferUpdate() { interaction.deferred = true; calls.push("defer"); },
    async editReply(payload: { components: any[] }) {
      calls.push(`edit:${payload.components[0].components[0].content}`);
    },
    async followUp() { calls.push("followUp"); },
    async reply() { calls.push("reply"); },
  };
  await routeButton(interaction as never, {
    config: { GUILD_ID: "guild-1" },
    client: { user: { id: "bot-1" } },
    db,
    log: { warn() {} },
  } as never);
  assert.deepEqual(calls, ["defer", "edit:Hello"]);
});

test("button routing falls through from common legacy v0 state to the old X handler without double acknowledgement", async () => {
  const now = new Date();
  const db = {
    insertInto(table: string) {
      assert.equal(table, "preview_translation_states");
      const query = {
        values: () => query,
        onConflict: () => query,
        execute: async () => undefined,
      };
      return query;
    },
    selectFrom(table: string) {
      const query = {
        selectAll: () => query,
        where: () => query,
        executeTakeFirst: async () => table === "preview_translation_states"
          ? {
            message_id: "message-x",
            guild_id: "guild-1",
            channel_id: "channel-1",
            source_kind: "x",
            source_url: "https://x.com/user/status/123",
            document: { version: 0, source: "x", legacyTweet: { id: "123" } },
            translations: { version: 0, source: "x", legacyTranslations: {} },
            expires_at: new Date(now.getTime() + 60_000),
            created_at: now,
            updated_at: now,
          }
          : {
            message_id: "message-x",
            guild_id: "guild-1",
            channel_id: "channel-1",
            tweet_url: "https://x.com/user/status/123",
            tweet: {
              id: "123",
              url: "https://x.com/user/status/123",
              text: "Hello",
              author: { screenName: "user" },
              sensitive: false,
              media: [],
            },
            translations: {
              model: "legacy-model",
              main: {
                shouldTranslate: true,
                sourceLanguage: "en",
                confidence: 1,
                translatedText: "こんにちは",
              },
            },
            expires_at: new Date(now.getTime() + 60_000),
            created_at: now,
            updated_at: now,
          },
      };
      return query;
    },
  };
  const calls: string[] = [];
  const interaction = {
    customId: "vxpreview:show-original",
    guildId: "guild-1",
    channelId: "channel-1",
    message: {
      id: "message-x",
      author: { id: "bot-1" },
      components: [],
    },
    async deferUpdate() { calls.push("defer"); },
    async editReply() { calls.push("edit"); },
    async followUp() { calls.push("followUp"); },
  };
  await routeButton(interaction as never, {
    config: { GUILD_ID: "guild-1" },
    client: { user: { id: "bot-1" } },
    db,
    log: { warn() {} },
  } as never);
  assert.deepEqual(calls, ["defer", "edit"]);
});

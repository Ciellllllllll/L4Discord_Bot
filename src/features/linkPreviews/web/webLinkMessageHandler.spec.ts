import assert from "node:assert/strict";
import { test } from "node:test";
import { MessageFlags } from "discord.js";
import { LinkPreviewMessageHandler } from "../linkPreviewMessageHandler.js";
import type { WebPreviewBuildResult } from "./webLinkExpansion.js";

function createCtx(): unknown {
  return {
    config: { GUILD_ID: "guild-1", YOUTUBE_PREVIEW_ENABLED: true, YOUTUBE_DATA_API_KEY: "", YOUTUBE_REQUEST_TIMEOUT_MS: 10 },
    db: {
      selectFrom: () => ({
        selectAll: () => ({ where: () => ({ executeTakeFirst: async () => ({ guild_id: "guild-1", data: "{}" }) }) }),
      }),
    },
    log: { error() {}, warn() {} },
  };
}

function message(content: string) {
  const calls = { suppressed: 0, replies: [] as Array<{ key: string; payload: unknown }> };
  return {
    calls,
    value: {
      id: "message-1",
      author: { bot: false, id: "user-1" },
      guild: { id: "guild-1", premiumTier: 0 },
      guildId: "guild-1",
      channelId: "channel-1",
      content,
      embeds: [],
      suppressEmbeds: async () => { calls.suppressed += 1; },
    },
  };
}

function success(url: string): WebPreviewBuildResult {
  return {
    target: { url },
    status: "success",
    payload: { embeds: [], flags: MessageFlags.IsComponentsV2, components: [], allowedMentions: { parse: [], repliedUser: false } },
  };
}

void test("suppresses the embed and sends a card when a generic https page was loaded", async () => {
  const { value, calls } = message("これ https://news.example/post <https://quiet.example/>");
  const requested: string[] = [];
  const handler = new LinkPreviewMessageHandler(createCtx() as never, {
    replyExpansion: async (_message, key, payload) => { calls.replies.push({ key, payload }); return { id: "reply-1" } as never; },
    buildWebReplyPayloads: async (targets) => {
      requested.push(...targets.map((target) => target.url));
      return targets.map((target) => success(target.url));
    },
    suppressLateEmbeds: async () => undefined,
    lateEmbedWatcher: null,
  });
  assert.equal(handler.hasLinks(value as never), true);
  await handler.onMessage(value as never);
  assert.deepEqual(requested, ["https://news.example/post"]);
  assert.equal(calls.suppressed, 1);
  assert.deepEqual(calls.replies.map((reply) => reply.key), ["web:0"]);
});

void test("keeps Discord's own embed when the page could not be loaded", async () => {
  const { value, calls } = message("https://down.example/");
  await new LinkPreviewMessageHandler(createCtx() as never, {
    replyExpansion: async (_message, key, payload) => { calls.replies.push({ key, payload }); return { id: "reply-1" } as never; },
    buildWebReplyPayloads: async (targets) => targets.map((target) => ({ target, status: "error", reason: "timeout" })),
    lateEmbedWatcher: null,
  }).onMessage(value as never);
  assert.equal(calls.suppressed, 0);
  assert.equal(calls.replies.length, 0);
});

void test("replaces the suppressed embed of a failed link with a fallback card in mixed messages", async () => {
  const { value, calls } = message("https://news.example/post https://down.example/");
  await new LinkPreviewMessageHandler(createCtx() as never, {
    replyExpansion: async (_message, key, payload) => { calls.replies.push({ key, payload }); return { id: "reply-1" } as never; },
    buildWebReplyPayloads: async (targets) => targets.map((target, index) => (
      index === 0 ? success(target.url) : { target, status: "error", reason: "timeout" }
    )),
    suppressLateEmbeds: async () => undefined,
    lateEmbedWatcher: null,
  }).onMessage(value as never);
  assert.equal(calls.suppressed, 1);
  assert.deepEqual(calls.replies.map((reply) => reply.key), ["web:0", "web:1"]);
  assert.match(JSON.stringify(calls.replies[1]!.payload), /ページの情報を取得できませんでした/);
});

void test("does not treat suppressed or dedicated links as generic web links", () => {
  const handler = new LinkPreviewMessageHandler(createCtx() as never, { lateEmbedWatcher: null });
  assert.equal(handler.hasLinks(message("<https://quiet.example/>").value as never), false);
  assert.equal(handler.hasLinks(message("https://example.com/cat.gif").value as never), false);
});

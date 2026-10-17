import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { LinkPreviewMessageHandler } from "../linkPreviews/linkPreviewMessageHandler.js";
import { LeaveNotifierMessageHandler } from "./leaveNotifier.js";
import { runUtilitiesMessageChain, type UtilitiesMessageBundle } from "./utilitiesMessage.js";

void test("only supported links enter persistent expansion tracking, including scheme-less links", async () => {
  const calls: string[] = [];
  const ctx = {
    config: { GUILD_ID: "guild", YOUTUBE_PREVIEW_ENABLED: true }, client: {}, log: { warn() {} },
  } as unknown as BotContext;
  const noop = { onMessage: async () => undefined };
  const bundle = {
    log: ctx.log,
    expansions: { onCreate: async (message: Message) => { calls.push(message.content); } },
    coldLaugh: noop, catApiResponder: noop, dogApiResponder: noop, keywordResponder: noop,
    linkPreview: new LinkPreviewMessageHandler(ctx), leaveNotifierMessages: new LeaveNotifierMessageHandler(ctx),
  } as unknown as UtilitiesMessageBundle;
  for (const [content, bot] of [
    ["通常の会話", false], ["https://example.com/article", false],
    ["https://discord.com/channels/100/200/300", true],
    ["x.com/user/status/123", false], ["youtu.be/dQw4w9WgXcQ", false],
    ["github.com/octo/hello", false], ["https://discord.com/channels/100/200/300", false],
  ] as const) {
    await runUtilitiesMessageChain(bundle, {
      content, guildId: "guild", author: { bot }, embeds: [], client: { emit() {} },
    } as unknown as Message);
  }
  assert.deepEqual(calls, [
    "x.com/user/status/123", "youtu.be/dQw4w9WgXcQ", "github.com/octo/hello",
    "https://discord.com/channels/100/200/300",
  ]);
});

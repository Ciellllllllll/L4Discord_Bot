import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "discord.js";
import type { CoreDeps } from "../../core/deps.js";
import { LinkPreviewMessageHandler } from "../linkPreviews/linkPreviewMessageHandler.js";
import type { LinkPreviewHandlerDeps } from "../linkPreviews/linkPreviewMessageHandler.js";
import { LeaveNotifierMessageHandler } from "./leaveNotifier.js";
import { runUtilitiesMessageChain, runUtilitiesMessageUpdate, type UtilitiesMessageBundle } from "./utilitiesMessage.js";

void test("only supported links enter persistent expansion tracking, including scheme-less links", async () => {
  const calls: string[] = [];
  const ctx = {
    config: { GUILD_ID: "guild", YOUTUBE_PREVIEW_ENABLED: true }, client: {}, log: { warn() {} },
  } as unknown as Pick<CoreDeps, "config" | "db" | "log" | "client">;
  const noop = { onMessage: async () => undefined };
  const bundle = {
    log: ctx.log,
    expansions: { onCreate: async (message: Message) => { calls.push(message.content); } },
    coldLaugh: noop, catApiResponder: noop, dogApiResponder: noop, keywordResponder: noop,
    linkPreview: new LinkPreviewMessageHandler(ctx as unknown as LinkPreviewHandlerDeps), leaveNotifierMessages: new LeaveNotifierMessageHandler(ctx),
  } as unknown as UtilitiesMessageBundle;
  for (const [content, bot] of [
    ["通常の会話", false], ["https://example.com/article", false],
    ["<https://example.com/suppressed>", false], ["https://example.com/image.png", false],
    ["https://discord.com/channels/100/200/300", true],
    ["x.com/user/status/123", false], ["youtu.be/dQw4w9WgXcQ", false],
    ["github.com/octo/hello", false], ["https://discord.com/channels/100/200/300", false],
  ] as const) {
    await runUtilitiesMessageChain(bundle, {
      content, guildId: "guild", author: { bot }, embeds: [], client: { emit() {} },
    } as unknown as Message);
  }
  assert.deepEqual(calls, [
    "https://example.com/article",
    "x.com/user/status/123", "youtu.be/dQw4w9WgXcQ", "github.com/octo/hello",
    "https://discord.com/channels/100/200/300",
  ]);
});

void test("edits that add a supported link to an untracked message enter expansion tracking once", async () => {
  const calls: string[] = [];
  const ctx = {
    config: { GUILD_ID: "guild", YOUTUBE_PREVIEW_ENABLED: true }, client: {}, log: { warn() {} },
  } as unknown as Pick<CoreDeps, "config" | "db" | "log" | "client">;
  const bundle = {
    log: ctx.log,
    expansions: {
      onUpdate: async (message: Message) => { calls.push(`update:${message.content}`); },
      onUntrackedUpdate: async (message: Message) => { calls.push(`untracked:${message.content}`); },
    },
    linkPreview: new LinkPreviewMessageHandler(ctx as unknown as LinkPreviewHandlerDeps), leaveNotifierMessages: new LeaveNotifierMessageHandler(ctx),
  } as unknown as UtilitiesMessageBundle;
  const edit = (before: string | null, content: string, extra: object = {}) => runUtilitiesMessageUpdate(
    bundle, { content: before } as Message,
    { content, guildId: "guild", author: { bot: false }, partial: false, ...extra } as unknown as Message,
  );
  await edit("元の本文", "github.com/octo/hello");
  await edit("github.com/octo/hello", "github.com/octo/hello", {});
  await edit("元の本文", "リンクなしの編集");
  await edit(null, "x.com/user/status/123");
  await runUtilitiesMessageUpdate(bundle, { content: "元" } as Message, {
    id: "partial", partial: true, content: null,
    fetch: async () => ({ content: "youtu.be/dQw4w9WgXcQ", guildId: "guild", author: { bot: false } }),
  } as unknown as Message);
  assert.deepEqual(calls, [
    "update:github.com/octo/hello", "untracked:github.com/octo/hello",
    "update:github.com/octo/hello",
    "update:リンクなしの編集",
    "update:x.com/user/status/123", "untracked:x.com/user/status/123",
    "update:null", "untracked:youtu.be/dQw4w9WgXcQ",
  ]);
});

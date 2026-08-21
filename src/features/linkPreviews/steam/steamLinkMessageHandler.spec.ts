import assert from "node:assert/strict";
import { test } from "node:test";
import { ComponentType, MessageFlags } from "discord.js";
import { LinkPreviewMessageHandler } from "../linkPreviewMessageHandler.js";

function createDb(): unknown {
  return {
    selectFrom: () => ({
      selectAll: () => ({
        where: () => ({ executeTakeFirst: async () => ({ guild_id: "guild-1", data: "{}" }) }),
      }),
    }),
  };
}

function createContext(): unknown {
  return {
    config: {
      GUILD_ID: "guild-1",
      YOUTUBE_PREVIEW_ENABLED: true,
      YOUTUBE_DATA_API_KEY: "",
      YOUTUBE_REQUEST_TIMEOUT_MS: 10,
    },
    db: createDb(),
    log: { warn() {}, error() {} },
  };
}

test("直接Steamリンクは元メッセージのEmbedを抑制し、Steamカードを個別返信する", async () => {
  const replies: unknown[] = [];
  const targets: string[] = [];
  let suppressCalls = 0;
  await new LinkPreviewMessageHandler(createContext() as never, {
    buildSteamReplyPayloads: async (steamTargets) => {
      targets.push(...steamTargets.map((target) => target.canonicalUrl));
      return [{
        embeds: [],
        flags: MessageFlags.IsComponentsV2,
        components: [],
        allowedMentions: { parse: [], repliedUser: false },
      }];
    },
  }).onMessage({
    author: { bot: false },
    guild: { id: "guild-1" },
    channelId: "channel-1",
    content: "",
    embeds: [{ footer: { text: "https://store.steampowered.com/app/730/Counter_Strike_2/" } }],
    suppressEmbeds: async () => { suppressCalls += 1; },
    reply: async (payload: unknown) => { replies.push(payload); },
  } as never);

  assert.equal(suppressCalls, 1);
  assert.deepEqual(targets, ["https://store.steampowered.com/app/730/Counter_Strike_2/"]);
  assert.equal(replies.length, 1);
});

test("X展開本文のSteamリンクは既存X Components v2を残したまま追加返信する", async () => {
  const replies: unknown[] = [];
  const targets: string[] = [];
  const existingXCard = {
    embeds: [],
    flags: MessageFlags.IsComponentsV2,
    components: [{ type: 1, content: "X本文カード" }],
    allowedMentions: { parse: [], repliedUser: false },
  };
  await new LinkPreviewMessageHandler(createContext() as never, {
    expandTwitterLinks: async (_message, _targets) => {
      replies.push(existingXCard);
      return ["https://store.steampowered.com/app/730/Counter_Strike_2/"];
    },
    buildSteamReplyPayloads: async (steamTargets) => {
      targets.push(...steamTargets.map((target) => target.canonicalUrl));
      return [{
        embeds: [],
        flags: MessageFlags.IsComponentsV2,
        components: [{ type: ComponentType.Container, components: [] }],
        allowedMentions: { parse: [], repliedUser: false },
      }];
    },
  }).onMessage({
    author: { bot: false },
    guild: { id: "guild-1" },
    channelId: "channel-1",
    content: "https://x.com/user/status/1",
    suppressEmbeds: async () => undefined,
    reply: async (payload: unknown) => { replies.push(payload); },
  } as never);

  assert.deepEqual(targets, ["https://store.steampowered.com/app/730/Counter_Strike_2/"]);
  assert.equal(replies[0], existingXCard);
  assert.equal((replies[1] as { flags: number }).flags, MessageFlags.IsComponentsV2);
});

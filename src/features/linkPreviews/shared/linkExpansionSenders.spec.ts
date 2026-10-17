import assert from "node:assert/strict";
import { test } from "node:test";
import { ComponentType, MessageFlags, type Message } from "discord.js";
import { expandTwitterLinks } from "../twitter/twitterLinkExpansion.js";
import { sendSteamLinkExpansion } from "../steam/steamLinkExpansion.js";
import { sendGithubLinkExpansion } from "../github/githubLinkExpansion.js";
import { sendYouTubeLinkExpansion } from "../youtube/youtubeLinkExpansion.js";
import { expandTikTokLinks } from "../tiktok/tiktokLinkExpansion.js";
import { expandInstagramLinks } from "../instagram/instagramLinkExpansion.js";
import { LocalLlmQueue } from "../../ai/localLlmQueue.js";
import type { ExpansionReply } from "./linkExpansionTracker.js";

void test("all six preview senders register their responses through the shared expansion reply", async () => {
  const calls: string[] = [];
  const warnings: unknown[] = [];
  const source = {
    id: "source", guildId: "guild", channelId: "channel",
    reply: async () => { throw new Error("untracked reply must not be used"); },
  } as unknown as Message;
  const payload = {
    embeds: [] as [], flags: MessageFlags.IsComponentsV2 as const,
    components: [{ type: ComponentType.TextDisplay as const, content: "プレビュー" }],
    files: [], allowedMentions: { parse: [] as [], repliedUser: false as const },
  };
  const replyExpansion: ExpansionReply = async (message, key, sent) => {
    assert.equal(message, source);
    assert.deepEqual(sent.components, payload.components);
    calls.push(key);
    return { id: `reply-${key}` } as Message;
  };
  const deps = {
    db: {} as never, config: {} as never, log: { warn: (entry: unknown) => warnings.push(entry) }, replyExpansion,
    buildReplyPayloads: async () => [payload], attachmentSizeLimitBytes: 8 * 1024 * 1024,
    queue: new LocalLlmQueue({ maxConcurrent: 1, maxQueue: 1 }),
  };
  await expandTwitterLinks(source, [], deps);
  await sendSteamLinkExpansion(source, [], deps);
  await sendGithubLinkExpansion(source, [{ status: "success", target: {} as never, payload }], {
    db: deps.db, config: deps.config, log: deps.log, replyExpansion,
  });
  await sendYouTubeLinkExpansion(source, { items: [{
    target: { kind: "video", id: "abc", canonicalUrl: "https://youtu.be/abc", originalUrl: "https://youtu.be/abc" }, nativeEmbed: null,
  }] }, {
    ...deps,
    buildReplyPayloads: async () => [{ ...payload, resolvedMedia: { mediaUrl: "https://example.com/video.mp4" } }],
  });
  await expandTikTokLinks(source, [{ url: "https://www.tiktok.com/@user/video/1" }], deps);
  await expandInstagramLinks(source, [{ url: "https://www.instagram.com/p/abc/", shortcode: "abc", kind: "p" }], deps);
  assert.deepEqual(calls, ["twitter:0", "steam:0", "github:0", "youtube:0", "tiktok:0", "instagram:0"]);
  assert.deepEqual(warnings, []);
});

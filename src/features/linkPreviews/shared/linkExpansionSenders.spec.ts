import assert from "node:assert/strict";
import { test } from "node:test";
import { ComponentType, MessageFlags, type Message } from "discord.js";
import { buildTwitterReplyPayloads, expandTwitterLinks } from "../twitter/twitterLinkExpansion.js";
import { buildSteamReplyPayloads, sendSteamLinkExpansion } from "../steam/steamLinkExpansion.js";
import { buildGithubFailurePayload, sendGithubLinkExpansion } from "../github/githubLinkExpansion.js";
import { buildYouTubeReplyPayloads, sendYouTubeLinkExpansion } from "../youtube/youtubeLinkExpansion.js";
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

void test("transient Twitter, Steam and GitHub failures are reported as retryable fallbacks", async () => {
  const source = { id: "source", guildId: "guild", channelId: "channel" } as unknown as Message;
  const deps = (retries: Array<boolean | undefined>) => ({
    db: {} as never, config: {} as never, log: { warn: () => undefined },
    replyExpansion: (async (_message, _key, _payload, _quoted, options) => {
      retries.push(options?.retry);
      return { id: "reply" } as Message;
    }) as ExpansionReply,
  });
  const target = { id: "1", screenName: "user", originalUrl: "https://x.com/user/status/1", vxUrl: "https://vxtwitter.com/user/status/1" };
  const twitter = async (status: number) => {
    const retries: Array<boolean | undefined> = [];
    await expandTwitterLinks(source, [{ ...target, statusId: "1" }], {
      ...deps(retries),
      buildReplyPayloads: (targets, options) => buildTwitterReplyPayloads(targets, {
        ...options, fetcher: async () => new Response(null, { status }),
      }),
    });
    return retries;
  };
  assert.deepEqual(await twitter(503), [true]);
  assert.deepEqual(await twitter(404), [false]);

  const steamRetries: Array<boolean | undefined> = [];
  const steamTarget = { canonicalUrl: "https://store.steampowered.com/app/10/", appid: "10" } as never;
  const steamDeps = deps(steamRetries);
  await sendSteamLinkExpansion(source, [steamTarget], {
    ...steamDeps,
    buildReplyPayloads: (targets, options) => buildSteamReplyPayloads(targets, {
      ...options, exchangeRate: null,
      client: { fetchPagePreview: async () => { throw new Error("steam unavailable"); } } as never,
    }),
  });
  await sendSteamLinkExpansion(source, [steamTarget], {
    ...steamDeps,
    buildReplyPayloads: (targets, options) => buildSteamReplyPayloads(targets, {
      ...options, exchangeRate: null,
      client: { fetchPagePreview: async () => ({
        canonicalUrl: "https://store.steampowered.com/app/10/", title: "Game", body: "",
        price: { kind: "unknown" }, rating: {},
      }) } as never,
    }),
  });
  assert.deepEqual(steamRetries, [true, false]);

  const githubRetries: Array<boolean | undefined> = [];
  const githubTarget = { canonicalUrl: "https://github.com/o/r" } as never;
  const failure = (reason: "rate_limited" | "not_found") => ({
    target: githubTarget, status: "error" as const, reason, payload: buildGithubFailurePayload(githubTarget, reason),
  });
  await sendGithubLinkExpansion(source, [failure("rate_limited"), failure("not_found")], deps(githubRetries), { includeFailures: true });
  assert.deepEqual(githubRetries, [true, false]);
});

void test("transient YouTube fetch failures are reported as retryable component fallbacks", async () => {
  const source = { id: "source", guildId: "guild", channelId: "channel" } as unknown as Message;
  const run = async (status: number) => {
    const retries: Array<boolean | undefined> = [];
    await sendYouTubeLinkExpansion(source, { items: [{
      target: { kind: "video", id: `retry${status}`, canonicalUrl: `https://youtu.be/retry${status}`, originalUrl: `https://youtu.be/retry${status}` }, nativeEmbed: null,
    }] }, {
      db: {} as never, config: { YOUTUBE_REQUEST_TIMEOUT_MS: 1_000 } as never, log: { warn: () => undefined }, mediaResolver: async () => ({ status: "fallback", reason: "test" }) as never,
      replyExpansion: (async (_message, _key, _payload, _quoted, options) => {
        retries.push(options?.retry);
        return { id: "reply" } as Message;
      }) as ExpansionReply,
      buildReplyPayloads: (targets, options) => buildYouTubeReplyPayloads(targets, {
        ...options, fetcher: async () => new Response(null, { status }),
      }),
    });
    return retries;
  };
  assert.deepEqual(await run(503), [true]);
  assert.deepEqual(await run(404), [false]);
});

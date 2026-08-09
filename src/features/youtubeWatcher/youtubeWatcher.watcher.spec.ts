import assert from "node:assert/strict";
import { ComponentType, EmbedType, MessageFlags, type APIEmbed } from "discord.js";
import {
  buildYouTubeNotificationPayload,
  buildYouTubeWatcherPayload,
  probeYouTubeNativeEmbed,
  sendYouTubeWatcherNotification,
  youtubeWatcherAttachmentSizeLimit,
} from "./youtubeWatcher.watcher.js";

function collectText(payload: ReturnType<typeof buildYouTubeNotificationPayload>): string {
  const container = payload.components[0];
  if (container?.type !== ComponentType.Container) return "";
  return container.components.flatMap((component) => {
    if (component.type === ComponentType.TextDisplay) return [component.content];
    if (component.type === ComponentType.Section) return component.components.map((item) => item.content);
    return [];
  }).join("\n");
}

const entry = {
  videoId: "video-1",
  title: "T".repeat(300),
  channelTitle: "テストチャンネル",
  publishedAt: "2026-08-06T12:34:56Z",
  videoUrl: "https://www.youtube.com/watch?v=video-1",
  thumbnailUrl: "https://i.ytimg.com/vi/video-1/maxresdefault.jpg",
};

const payload = buildYouTubeNotificationPayload(entry);
assert.equal(payload.flags, MessageFlags.IsComponentsV2);
assert.deepEqual(payload.embeds, []);
assert.deepEqual(payload.allowedMentions, { parse: [] });
assert.equal(payload.components.length, 1);

const text = collectText(payload);
assert.equal(text.includes(`## ${entry.title.slice(0, 256)}`), true);
assert.equal(text.includes(entry.title), false);
assert.equal(text.includes(entry.videoUrl), true);
assert.equal(text.includes(entry.channelTitle), true);
assert.equal(text.includes(`<t:${Math.floor(Date.parse(entry.publishedAt) / 1000)}:F>`), true);

const container = payload.components[0];
assert.equal(container?.type, ComponentType.Container);
if (container?.type === ComponentType.Container) {
  const section = container.components.find((component) => component.type === ComponentType.Section);
  assert.equal(section?.accessory.type, ComponentType.Thumbnail);
  assert.equal(section?.accessory.media.url, entry.thumbnailUrl);
}

const withoutThumbnail = buildYouTubeNotificationPayload({ ...entry, thumbnailUrl: null });
const withoutThumbnailContainer = withoutThumbnail.components[0];
assert.equal(withoutThumbnailContainer?.type, ComponentType.Container);
if (withoutThumbnailContainer?.type === ComponentType.Container) {
  assert.equal(withoutThumbnailContainer.components.some((component) => component.type === ComponentType.Section), false);
}

const nativeEmbed: APIEmbed = {
  type: EmbedType.Video,
  title: "Native title",
  description: "Native description",
  url: "https://www.youtube.com/embed/video-1",
  thumbnail: { url: entry.thumbnailUrl },
  video: {
    url: "https://www.youtube.com/embed/video-1",
    proxy_url: "https://cdn.discordapp.com/attachments/1/2/video.mp4",
    content_type: "video/mp4",
  },
};

assert.equal(youtubeWatcherAttachmentSizeLimit({ guild: { premiumTier: 3 } } as never), 100 * 1000 * 1000);
assert.equal(youtubeWatcherAttachmentSizeLimit({ guild: { premiumTier: 2 } } as never), 50 * 1000 * 1000);
assert.equal(youtubeWatcherAttachmentSizeLimit({ guild: { premiumTier: 1 } } as never), 10 * 1024 * 1024);
const nativePayload = buildYouTubeNotificationPayload(entry, nativeEmbed);
assert.equal(nativePayload.flags, MessageFlags.IsComponentsV2);
assert.deepEqual(nativePayload.embeds, []);
const nativeContainer = nativePayload.components[0];
assert.equal(nativeContainer?.type, ComponentType.Container);
if (nativeContainer?.type === ComponentType.Container) {
  const media = nativeContainer.components.find((component) => component.type === ComponentType.MediaGallery);
  assert.equal(media?.items[0]?.media.url, nativeEmbed.video?.proxy_url);
}

const probeListeners = new Set<(oldMessage: unknown, newMessage: unknown) => void>();
const probeClient = {
  on: (_event: string, listener: (oldMessage: unknown, newMessage: unknown) => void) => { probeListeners.add(listener); },
  off: (_event: string, listener: (oldMessage: unknown, newMessage: unknown) => void) => { probeListeners.delete(listener); },
} as never;
let probeDeleted = false;
const probeTarget = {
  send: async (options: { content: string; allowedMentions: { parse: [] } }) => {
    assert.equal(options.content, entry.videoUrl);
    assert.deepEqual(options.allowedMentions, { parse: [] });
    return { id: "probe-1", embeds: [], delete: async () => { probeDeleted = true; } };
  },
} as never;
const probePromise = probeYouTubeNativeEmbed(probeTarget, entry, probeClient);
await new Promise((resolve) => setTimeout(resolve, 10));
for (const listener of probeListeners) listener({}, { id: "probe-1", embeds: [{ toJSON: () => nativeEmbed }] });
assert.deepEqual(await probePromise, nativeEmbed);
assert.equal(probeDeleted, true);

const builderClient = {
  on: (_event: string, listener: (oldMessage: unknown, newMessage: unknown) => void) => {
    setTimeout(() => listener({}, { id: "probe-1", embeds: [{ toJSON: () => nativeEmbed }] }), 0);
  },
  off: () => undefined,
} as never;
const builderPayload = await buildYouTubeWatcherPayload({
  client: builderClient,
  config: {
    YOUTUBE_DATA_API_KEY: "",
    YOUTUBE_REQUEST_TIMEOUT_MS: 1_000,
  },
  log: { warn: () => undefined },
} as never, probeTarget, entry);
assert.equal(builderPayload.flags, MessageFlags.IsComponentsV2);
assert.deepEqual(builderPayload.embeds, []);

const sendBuildOptions: boolean[] = [];
const sendAttempts: unknown[] = [];
const firstSendPayload = buildYouTubeNotificationPayload(entry, nativeEmbed);
const retrySendPayload = buildYouTubeNotificationPayload(entry);
const sendTarget = {
  send: async (payload: unknown) => {
    sendAttempts.push(payload);
    if (sendAttempts.length === 1) throw new Error("native payload rejected");
    return { id: "sent-after-retry" };
  },
} as never;
const sentMessage = await sendYouTubeWatcherNotification({
  client: builderClient,
  config: {},
  log: { warn: () => undefined },
} as never, sendTarget, entry, {
  buildPayload: async (_ctx, _target, _entry, options) => {
    sendBuildOptions.push(options?.skipNativeEmbed === true);
    return options?.skipNativeEmbed ? retrySendPayload : firstSendPayload;
  },
});
assert.equal(sentMessage.id, "sent-after-retry");
assert.deepEqual(sendBuildOptions, [false, true]);
assert.equal(sendAttempts.length, 2);

console.log("youtubeWatcher.watcher.spec.ts: all assertions passed");

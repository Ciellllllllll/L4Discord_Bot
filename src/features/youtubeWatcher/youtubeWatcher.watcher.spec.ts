import assert from "node:assert/strict";
import { ComponentType, MessageFlags } from "discord.js";
import { buildYouTubeNotificationPayload } from "./youtubeWatcher.watcher.js";

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

console.log("youtubeWatcher.watcher.spec.ts: all assertions passed");

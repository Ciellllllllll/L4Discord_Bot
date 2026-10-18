import assert from "node:assert/strict";
import { ButtonStyle, ComponentType, type APIButtonComponentWithURL, type APISectionComponent } from "discord.js";
import { componentCardsPayload } from "../panels/componentCard.js";
import { buildEpicFreeEmbed } from "./epicFreeEmbeds.js";
import type { EpicFreeCandidate } from "./epicFreeTypes.js";

const candidate: EpicFreeCandidate = {
  offerId: "offer",
  namespace: "namespace",
  title: "Free Epic Game",
  description: null,
  detectedType: "current_free_game",
  productSlug: "free-epic-game",
  url: "https://store.epicgames.com/p/free-epic-game",
  imageUrl: "https://cdn.example.com/epic-free.png",
  originalPrice: 1980,
  discountPrice: 0,
  currencyCode: "JPY",
  startDate: "2026-07-01T00:00:00.000Z",
  endDate: "2026-07-08T00:00:00.000Z",
  dedupeKey: "epic:offer",
  confidence: "high",
};

const card = buildEpicFreeEmbed(candidate);
const container = card.toContainer();
const text = container.components.flatMap((component) => {
  if (component.type === ComponentType.TextDisplay) return [component.content];
  if (component.type === ComponentType.Section) return component.components.map((item) => item.content);
  return [];
}).join("\n");
const section = container.components.find((component) => component.type === ComponentType.Section) as
  | APISectionComponent
  | undefined;

assert.equal(text.includes("ストアURL"), false);
assert.equal(text.includes(candidate.url), false);
assert.equal(text.includes("2026/07/01"), false);
assert.equal(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(text), false);
assert.match(text, /\*\*配布終了\*\*\n<t:1783468800:R>/);
assert.equal(section?.accessory.type, ComponentType.Thumbnail);
assert.equal(
  section?.accessory.media.url,
  "https://upload.wikimedia.org/wikipedia/commons/thumb/5/58/Epic_Games_Store_logo_2023_vertical_white.svg/330px-Epic_Games_Store_logo_2023_vertical_white.svg.png",
);

const actionRow = container.components.find((component) => component.type === ComponentType.ActionRow);
assert.ok(actionRow);
const buttons = actionRow.components.filter(
  (component): component is APIButtonComponentWithURL =>
    component.type === ComponentType.Button && component.style === ButtonStyle.Link,
);
assert.equal(buttons.length, 2);
assert.deepEqual(
  buttons.map((component) => component.label),
  ["ブラウザで閲覧", "Epic Launcherで開く"],
);
assert.deepEqual(
  buttons.map((component) => component.url),
  [
    "https://store.epicgames.com/p/free-epic-game",
    "https://launcher.store.epicgames.com/p/free-epic-game",
  ],
);

const mediaIndex = container.components.findIndex((component) => component.type === ComponentType.MediaGallery);
const actionRowIndex = container.components.findIndex((component) => component.type === ComponentType.ActionRow);
const media = container.components[mediaIndex];
assert.equal(media?.type, ComponentType.MediaGallery);
assert.deepEqual(
  media?.type === ComponentType.MediaGallery ? media.items.map((item) => item.media.url) : [],
  ["https://cdn.example.com/epic-free.png"],
);
assert.ok(actionRowIndex > mediaIndex, "link buttons must be placed below the image");

const payload = componentCardsPayload([card]);
assert.equal(payload.components.length, 1);
assert.equal(payload.components[0]?.type, ComponentType.Container);

console.log("epicFreeEmbeds.spec.ts: all assertions passed");

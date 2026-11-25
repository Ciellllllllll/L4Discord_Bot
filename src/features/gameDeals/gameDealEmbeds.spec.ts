import assert from "node:assert/strict";
import { ButtonStyle, ComponentType, type APIButtonComponentWithURL, type APISectionComponent } from "discord.js";
import { componentCardsPayload } from "../../core/componentCard.js";
import { buildSteamFreeEventEmbed } from "./gameDealEmbeds.js";
import type { SteamFreeEvent } from "./gameDealTypes.js";

const event: SteamFreeEvent = {
  appid: "123",
  title: "Free Steam Game",
  stateKey: "steam_now:123:1",
  priceChangeNumber: 1,
  lastModified: 100,
  normalPriceCents: 198000,
  currentPriceCents: 0,
  discountPercent: 100,
  evidenceJson: "[]",
  steamUrl: "https://store.steampowered.com/app/123/Free_Steam_Game/",
  imageUrl: "https://cdn.example.com/steam-free.png",
  freeUntilUnix: 1783468800,
};

const card = buildSteamFreeEventEmbed(event);
const container = card.toContainer();
const text = container.components.flatMap((component) => {
  if (component.type === ComponentType.TextDisplay) return [component.content];
  if (component.type === ComponentType.Section) return component.components.map((item) => item.content);
  return [];
}).join("\n");
const section = container.components.find((component) => component.type === ComponentType.Section) as
  | APISectionComponent
  | undefined;

assert.equal(text.includes("Steam URL"), false);
assert.equal(text.includes(event.steamUrl), false);
assert.equal(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(text), false);
assert.match(text, /\*\*配布終了\*\*\n<t:1783468800:R>/);
assert.equal(section?.accessory.type, ComponentType.Thumbnail);
assert.equal(
  section?.accessory.media.url,
  "https://upload.wikimedia.org/wikipedia/commons/thumb/8/83/Steam_icon_logo.svg/330px-Steam_icon_logo.svg.png",
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
  ["ブラウザで閲覧", "Steam Clientで開く"],
);
assert.deepEqual(
  buttons.map((component) => component.url),
  [
    "https://store.steampowered.com/app/123/Free_Steam_Game/",
    "https://s.team/a/123",
  ],
);

const mediaIndex = container.components.findIndex((component) => component.type === ComponentType.MediaGallery);
const actionRowIndex = container.components.findIndex((component) => component.type === ComponentType.ActionRow);
const media = container.components[mediaIndex];
assert.equal(media?.type, ComponentType.MediaGallery);
assert.deepEqual(
  media?.type === ComponentType.MediaGallery ? media.items.map((item) => item.media.url) : [],
  ["https://cdn.example.com/steam-free.png"],
);
assert.ok(actionRowIndex > mediaIndex, "link buttons must be placed below the image");

const payload = componentCardsPayload([card]);
assert.equal(payload.components.length, 1);
assert.equal(payload.components[0]?.type, ComponentType.Container);

console.log("gameDealEmbeds.spec.ts: all assertions passed");

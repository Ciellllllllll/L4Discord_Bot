import assert from "node:assert/strict";
import { ButtonStyle, ComponentType, type APIButtonComponentWithURL } from "discord.js";
import { componentCardsPayload } from "../panels/componentCard.js";
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
  imageUrl: null,
};

const card = buildSteamFreeEventEmbed(event);
const container = card.toContainer();
const text = container.components.find((component) => component.type === ComponentType.TextDisplay)?.content ?? "";

assert.equal(text.includes("Steam URL"), false);
assert.equal(text.includes(event.steamUrl), false);

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

const payload = componentCardsPayload([card]);
assert.equal(payload.components.length, 1);
assert.equal(payload.components[0]?.type, ComponentType.Container);

console.log("gameDealEmbeds.spec.ts: all assertions passed");

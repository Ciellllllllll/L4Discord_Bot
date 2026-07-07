import assert from "node:assert/strict";
import { ButtonStyle, ComponentType, type APIButtonComponentWithURL } from "discord.js";
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
  imageUrl: null,
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
const text = container.components.find((component) => component.type === ComponentType.TextDisplay)?.content ?? "";

assert.equal(text.includes("ストアURL"), false);
assert.equal(text.includes(candidate.url), false);
assert.equal(text.includes("2026/07/01"), false);
assert.match(text, /\*\*配布終了\*\*\n<t:1783468800:R>/);

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

const payload = componentCardsPayload([card]);
assert.equal(payload.components.length, 1);
assert.equal(payload.components[0]?.type, ComponentType.Container);

console.log("epicFreeEmbeds.spec.ts: all assertions passed");

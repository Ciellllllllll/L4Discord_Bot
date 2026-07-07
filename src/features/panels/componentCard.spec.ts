import assert from "node:assert/strict";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, type APISectionComponent } from "discord.js";
import { ComponentCardBuilder, componentCardsPayload } from "./componentCard.js";

function collectText(container: ReturnType<ComponentCardBuilder["toContainer"]>): string {
  return container.components.flatMap((component) => {
    if (component.type === ComponentType.TextDisplay) return [component.content];
    if (component.type === ComponentType.Section) return component.components.map((item) => item.content);
    return [];
  }).join("\n");
}

function run(): void {
  const card = new ComponentCardBuilder()
    .setTitle("画像つきカード")
    .setDescription("本文")
    .setImage("https://example.com/main.png")
    .setThumbnail("https://example.com/thumb.png");

  const container = card.toContainer();
  const text = collectText(container);
  assert.equal(text.includes("画像:"), false);
  assert.equal(text.includes("サムネイル:"), false);

  const section = container.components.find((component) => component.type === ComponentType.Section) as
    | APISectionComponent
    | undefined;
  assert.equal(section?.accessory.type, ComponentType.Thumbnail);
  assert.equal(section?.accessory.media.url, "https://example.com/thumb.png");

  const galleries = container.components.filter((component) => component.type === ComponentType.MediaGallery);
  assert.equal(galleries.length, 1);
  assert.deepEqual(
    galleries.map((gallery) => gallery.items[0]?.media.url),
    ["https://example.com/main.png"],
  );

  const imageOnly = new ComponentCardBuilder().setImage("https://example.com/only.png").toContainer();
  assert.equal(imageOnly.components.some((component) => component.type === ComponentType.MediaGallery), true);
  for (const component of imageOnly.components) {
    if (component.type === ComponentType.TextDisplay) {
      assert.notEqual(component.content, "");
    }
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("component-card:test")
      .setLabel("テスト")
      .setStyle(ButtonStyle.Primary),
  );
  const payload = componentCardsPayload([card], [row]);
  assert.equal(payload.components.length, 1);
  assert.equal(payload.components[0]?.type, ComponentType.Container);
  const payloadContainer = payload.components[0];
  assert.equal(payloadContainer.components.at(-1)?.type, ComponentType.ActionRow);
}

run();
console.log("componentCard.spec.ts: all assertions passed");

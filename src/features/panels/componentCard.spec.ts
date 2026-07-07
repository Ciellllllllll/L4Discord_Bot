import assert from "node:assert/strict";
import { ComponentType } from "discord.js";
import { ComponentCardBuilder } from "./componentCard.js";

function run(): void {
  const card = new ComponentCardBuilder()
    .setTitle("画像つきカード")
    .setDescription("本文")
    .setImage("https://example.com/main.png")
    .setThumbnail("https://example.com/thumb.png");

  const container = card.toContainer();
  const text = container.components.find((component) => component.type === ComponentType.TextDisplay);
  assert.equal(text?.content.includes("画像:"), false);
  assert.equal(text?.content.includes("サムネイル:"), false);

  const galleries = container.components.filter((component) => component.type === ComponentType.MediaGallery);
  assert.equal(galleries.length, 2);
  assert.deepEqual(
    galleries.map((gallery) => gallery.items[0]?.media.url),
    ["https://example.com/main.png", "https://example.com/thumb.png"],
  );

  const imageOnly = new ComponentCardBuilder().setImage("https://example.com/only.png").toContainer();
  assert.equal(imageOnly.components.some((component) => component.type === ComponentType.MediaGallery), true);
  for (const component of imageOnly.components) {
    if (component.type === ComponentType.TextDisplay) {
      assert.notEqual(component.content, "");
    }
  }
}

run();
console.log("componentCard.spec.ts: all assertions passed");

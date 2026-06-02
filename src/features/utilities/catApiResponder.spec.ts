import assert from "node:assert/strict";
import { buildTheCatApiSearchUrl, containsCatTrigger } from "./catApiResponder.js";

function run(): void {
  for (const text of ["猫", "ねこ", "NEKO", "neko", "neco", "NECO", "今日は猫です"]) {
    assert.equal(containsCatTrigger(text), true, text);
  }

  for (const text of ["犬", "cat", "寝る", ""]) {
    assert.equal(containsCatTrigger(text), false, text);
  }

  const url = new URL(buildTheCatApiSearchUrl("https://api.thecatapi.com/"));
  assert.equal(url.origin, "https://api.thecatapi.com");
  assert.equal(url.pathname, "/v1/images/search");
  assert.equal(url.searchParams.get("limit"), "1");
  assert.equal(url.searchParams.get("mime_types"), "jpg,png,gif,mp4");
}

try {
  run();
  console.log("catApiResponder.spec.ts: all assertions passed");
} catch (err) {
  console.error(err);
  process.exit(1);
}

import assert from "node:assert/strict";
import { coldLaughHitsForMessageContent, stripLinksForColdLaughContent } from "./linkAndColdLaugh.js";

function run(): void {
  assert.equal(coldLaughHitsForMessageContent("https://example.com/落ち着けw"), 0);
  assert.equal(coldLaughHitsForMessageContent("x.com/user/status/123/落ち着けw"), 0);
  assert.equal(coldLaughHitsForMessageContent("www.example.com/怒んなやw"), 0);
  assert.equal(coldLaughHitsForMessageContent("discord.gg/落ち着けw"), 0);

  assert.equal(coldLaughHitsForMessageContent("落ち着けw https://example.com/post"), 2);
  assert.equal(coldLaughHitsForMessageContent("https://example.com/post 怒んなやw"), 1);

  assert.equal(stripLinksForColdLaughContent("see https://example.com/落ち着けw now").trim(), "see   now");
}

try {
  run();
  console.log("linkAndColdLaugh.spec.ts: all assertions passed");
} catch (err) {
  console.error(err);
  process.exit(1);
}

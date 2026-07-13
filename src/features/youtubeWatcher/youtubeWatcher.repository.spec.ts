import assert from "node:assert/strict";
import test from "node:test";
import { toUnnotifiedEntries } from "./youtubeWatcher.repository.js";

test("toUnnotifiedEntries includes entries without a sent notification and orders oldest first", () => {
  const entries = [
    { videoId: "new", publishedAt: "2026-07-13T01:00:00.000Z" },
    { videoId: "old", publishedAt: "2026-07-13T00:00:00.000Z" },
  ];
  assert.deepEqual(toUnnotifiedEntries(entries, new Set(["new"])), [entries[1]]);
});

import assert from "node:assert/strict";
import type { PreviewDocument, PreviewSource } from "./previewDocument.js";

const supportedSources: PreviewSource[] = ["x", "youtube", "steam", "github"];

const document: PreviewDocument = {
  version: 1,
  source: "youtube",
  url: "https://www.youtube.com/watch?v=example",
  openLabel: "YouTubeで開く",
  blocks: [
    {
      type: "text",
      id: "summary",
      thumbnailUrl: "https://example.test/thumb.jpg",
      thumbnailDescription: "サムネイル",
      lines: [{
        prefix: "投稿者: ",
        parts: [
          { text: "Example channel", strong: true },
          { text: " — " },
          { text: "Hello world", translationKey: "summary" },
        ],
      }],
    },
    {
      type: "media",
      id: "images",
      items: [{ url: "https://example.test/image.jpg", description: "画像", spoiler: true }],
    },
  ],
};

assert.equal(document.version, 1);
assert.deepEqual(supportedSources, ["x", "youtube", "steam", "github"]);
assert.equal(document.blocks[0]?.type, "text");
assert.equal(document.blocks[1]?.type, "media");
console.log("previewDocument.spec.ts: all assertions passed");

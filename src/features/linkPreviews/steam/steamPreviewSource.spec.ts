import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collectSteamReplyTargets,
  extractSteamLinks,
  parseSteamUrl,
  steamPreviewToDocument,
} from "./steamPreviewSource.js";
import type { SteamPagePreview } from "../../steam/steamStoreClient.js";

test("Steam URLを公式ドメインだけ正規化し、重複除去して最大5件に制限する", () => {
  assert.deepEqual(extractSteamLinks([
    "store.steampowered.com/app/730/?utm_source=x",
    "https://store.steampowered.com/app/730/Counter_Strike_2/",
    "https://steamcommunity.com/sharedfiles/filedetails/?id=1",
    "https://help.steampowered.com/en/",
    "https://a.steampowered.com/path",
    "https://store.steampowered.com/app/1/",
    "https://store.steampowered.com/app/2/",
    "https://store.steampowered.com/app/3/",
    "https://store.steampowered.com/app/4/",
  ].join(" ")).length, 9);

  assert.deepEqual(parseSteamUrl("https://store.steampowered.com/app/730/Counter_Strike_2/?cc=jp"), {
    canonicalUrl: "https://store.steampowered.com/app/730/Counter_Strike_2/",
    appid: "730",
  });
  assert.deepEqual(extractSteamLinks('紹介文 <a href="https://store.steampowered.com/app/730/">Steam</a>'), [
    "https://store.steampowered.com/app/730/",
  ]);
  assert.equal(parseSteamUrl("https://example.com/https://store.steampowered.com/app/1/"), null);

  const targets = collectSteamReplyTargets([
    "https://store.steampowered.com/app/730/Counter_Strike_2/?utm_source=x",
    "https://store.steampowered.com/app/730/Counter_Strike_2/",
    "https://steamcommunity.com/sharedfiles/filedetails/?id=1",
    "https://help.steampowered.com/en/",
    "https://a.steampowered.com/path",
    "https://store.steampowered.com/app/1/",
    "https://store.steampowered.com/app/2/",
  ]);
  assert.equal(targets.length, 5);
  assert.deepEqual(targets.map((target) => target.appid), ["730", undefined, undefined, undefined, "1"]);
  assert.equal(new Set(targets.map((target) => target.canonicalUrl)).size, 5);
});

test("Steamプレビュー文書はタイトルを翻訳対象にせず、価格・評価・Clientボタンを保持する", () => {
  const preview: SteamPagePreview = {
    canonicalUrl: "https://store.steampowered.com/app/730/Counter_Strike_2/",
    appid: "730",
    title: "Counter-Strike 2",
    body: "A competitive tactical shooter.",
    price: { kind: "paid", usd: 9.99 },
    rating: { label: "Mostly Positive", percent: 76, reviewCount: 78_889 },
    imageUrl: "https://cdn.example.test/header.jpg",
  };

  const document = steamPreviewToDocument(preview, 150.15015015015015);
  assert.equal(document.source, "steam");
  assert.deepEqual(document.secondaryAction, {
    label: "Steam Clientで開く",
    url: "https://s.team/a/730",
  });

  const parts = document.blocks
    .filter((block) => block.type === "text")
    .flatMap((block) => block.lines.flatMap((line) => line.parts));
  assert.equal(parts.find((part) => part.text === "Counter-Strike 2")?.translationKey, undefined);
  assert.equal(parts.some((part) => part.translationKey === "body"), true);
  assert.equal(parts.some((part) => part.translationKey === "rating"), true);
  assert.equal(parts.some((part) => part.text.includes("¥1,500円 ($9.99)")), true);
  assert.equal(
    steamPreviewToDocument({ ...preview, appid: undefined }, 150).secondaryAction,
    undefined,
  );
  assert.equal(
    steamPreviewToDocument(preview, null).blocks.some((block) => block.type === "text" && block.lines.some((line) => line.parts.some((part) => part.text.includes("為替未取得")))),
    true,
  );
  assert.equal(
    steamPreviewToDocument(preview, 0).blocks.some((block) => block.type === "text" && block.lines.some((line) => line.parts.some((part) => part.text.includes("為替未取得")))),
    true,
  );

  const freeDocument = steamPreviewToDocument({
    ...preview,
    price: { kind: "free" },
  }, 150);
  assert.equal(
    freeDocument.blocks.some((block) => block.type === "text" && block.lines.some((line) => line.parts.some((part) => part.text === "無料"))),
    true,
  );

  const unknownDocument = steamPreviewToDocument({
    ...preview,
    price: { kind: "unknown" },
  }, 150);
  assert.equal(
    unknownDocument.blocks.some((block) => block.type === "text" && block.lines.some((line) => line.parts.some((part) => part.text === "不明"))),
    true,
  );
});

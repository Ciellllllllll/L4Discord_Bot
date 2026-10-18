import assert from "node:assert/strict";
import { test } from "node:test";
import { isHtmlContentType } from "./webPageFetcher.js";
import {
  collectWebReplyTargets,
  decodeHtml,
  extractWebLinks,
  parseWebPageHtml,
  parseWebUrl,
  webPreviewToDocument,
} from "./webPreviewSource.js";

void test("extracts https links but skips links wrapped in angle brackets", () => {
  assert.deepEqual(extractWebLinks([
    "見て https://example.com/a。",
    "<https://example.com/suppressed>",
    "http://example.com/plain",
    "[記事](https://example.com/masked)",
    "**https://example.com/bold**",
  ].join(" ")), [
    "https://example.com/a",
    "https://example.com/masked",
    "https://example.com/bold",
  ]);
});

void test("leaves links with dedicated or native expansions to their own handlers", () => {
  for (const url of [
    "https://x.com/user/status/1",
    "https://www.youtube.com/watch?v=abc",
    "https://youtu.be/abc",
    "https://www.tiktok.com/@u/video/1",
    "https://www.instagram.com/p/abc/",
    "https://github.com/octo/hello",
    "https://store.steampowered.com/app/10/",
    "https://discord.com/channels/1/2/3",
    "https://cdn.discordapp.com/attachments/1/2/a.txt",
    "https://tenor.com/view/cat-123",
    "https://open.spotify.com/track/abc",
    "https://example.com/photo.JPG",
    "https://example.com:8443/admin",
    "https://user:pass@example.com/",
    "https://localhost-without-dot/",
    `https://example.com/${"a".repeat(520)}`,
  ]) {
    assert.equal(parseWebUrl(url), null, url);
  }
  assert.deepEqual(parseWebUrl("https://news.example.jp/article/1#comments"), { url: "https://news.example.jp/article/1" });
  assert.deepEqual(parseWebUrl("https://notgithub.com/octo"), { url: "https://notgithub.com/octo" });
});

void test("deduplicates targets and caps them at three per message", () => {
  assert.deepEqual(collectWebReplyTargets([
    "https://a.example/1", "https://a.example/1#x", "https://b.example/", "https://c.example/", "https://d.example/",
  ]).map((target) => target.url), ["https://a.example/1", "https://b.example/", "https://c.example/"]);
});

void test("decodes Shift_JIS pages using the meta charset", () => {
  const html = Buffer.concat([
    Buffer.from('<html><head><meta charset="Shift_JIS"><title>', "latin1"),
    Buffer.from([0x82, 0xa0]), // 「あ」
    Buffer.from("</title></head></html>", "latin1"),
  ]);
  assert.match(decodeHtml(html, "text/html"), /<title>あ<\/title>/);
  assert.match(decodeHtml(Buffer.from("<title>い</title>"), "text/html; charset=bogus-charset"), /い/);
  assert.equal(isHtmlContentType("text/html; charset=utf-8"), true);
  assert.equal(isHtmlContentType("application/pdf"), false);
});

void test("parses OGP metadata and the main article text", () => {
  const html = `<!doctype html><html><head>
    <title>Fallback title</title>
    <meta property="og:title" content="  Big   News  ">
    <meta property="og:description" content="Something happened.">
    <meta property="og:site_name" content="Example News">
    <meta property="og:image" content="/images/cover.png">
    <meta property="og:image:alt" content="Cover">
    </head><body>
    <nav><p>Menu item that should be ignored</p></nav>
    <article><h1>Big News</h1><p>${"First paragraph. ".repeat(10)}</p><p>Second paragraph.</p></article>
    <script>var ignored = true;</script>
    </body></html>`;
  const page = parseWebPageHtml(html, "https://news.example/post", "https://www.news.example/post?ref=1");
  assert.ok(page);
  assert.equal(page.title, "Big News");
  assert.equal(page.description, "Something happened.");
  assert.equal(page.siteName, "Example News");
  assert.equal(page.imageUrl, "https://www.news.example/images/cover.png");
  assert.equal(page.imageAlt, "Cover");
  assert.equal(page.largeImage, true);
  assert.match(page.text, /First paragraph/);
  assert.match(page.text, /Second paragraph/);
  assert.doesNotMatch(page.text, /Menu item|ignored = true/);
  assert.equal(page.url, "https://news.example/post");
});

void test("uses fallbacks, small thumbnails for summary cards, and rejects pages without a title", () => {
  const page = parseWebPageHtml(`<html><head><title>Plain page</title>
    <meta name="description" content="Desc">
    <meta name="twitter:card" content="summary">
    <meta name="twitter:image" content="http://insecure.example/a.png">
    </head><body><p>short</p></body></html>`, "https://plain.example/");
  assert.ok(page);
  assert.equal(page.title, "Plain page");
  assert.equal(page.description, "Desc");
  assert.equal(page.imageUrl, undefined);
  assert.equal(page.largeImage, false);
  assert.equal(page.text, "short");
  assert.equal(parseWebPageHtml("<html><body>no title</body></html>", "https://none.example/"), null);
});

void test("builds an article card document with the large image above the text", () => {
  const document = webPreviewToDocument({
    url: "https://news.example/post",
    title: "Big News",
    description: "Something happened.",
    siteName: "Example News",
    imageUrl: "https://news.example/cover.png",
    largeImage: true,
    text: "body",
  });
  assert.equal(document.source, "web");
  assert.equal(document.openLabel, "リンクを開く");
  assert.equal(document.summaryAction, true);
  assert.deepEqual(document.blocks.map((block) => block.type), ["media", "text"]);
  const text = document.blocks[1];
  assert.ok(text?.type === "text");
  assert.equal(text.thumbnailUrl, undefined);
  assert.deepEqual(text.lines.map((line) => line.parts.map((part) => part.translationKey ?? null)), [["title"], ["description"], [null]]);
  assert.equal(text.lines[2]?.parts[0]?.text, "Example News · news.example");

  const small = webPreviewToDocument({
    url: "https://news.example/post", title: "T", imageUrl: "https://news.example/icon.png", largeImage: false, text: "",
  });
  assert.deepEqual(small.blocks.map((block) => block.type), ["text"]);
  assert.equal(small.blocks[0]?.type === "text" ? small.blocks[0].thumbnailUrl : undefined, "https://news.example/icon.png");
});

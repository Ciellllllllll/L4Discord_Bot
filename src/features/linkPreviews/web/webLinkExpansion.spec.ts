import assert from "node:assert/strict";
import { test } from "node:test";
import { ButtonStyle, ComponentType } from "discord.js";
import { PREVIEW_SHOW_ORIGINAL_ID, PREVIEW_SUMMARY_ID } from "../shared/previewRenderer.js";
import { buildWebReplyPayloads, loadWebPage, sendWebLinkExpansion } from "./webLinkExpansion.js";
import type { WebPageFetcher } from "./webPageFetcher.js";

const HTML = `<html><head>
  <meta property="og:title" content="Big News">
  <meta property="og:description" content="Something happened.">
  <meta property="og:image" content="https://news.example/cover.png">
  </head><body><article><p>Body</p></article></body></html>`;

function fetcher(html = HTML, contentType = "text/html; charset=utf-8"): WebPageFetcher {
  return async (url) => ({
    status: "ok",
    response: { status: 200, finalUrl: url, contentType, body: Buffer.from(html) },
  });
}

function buttons(components: unknown): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const component = value as Record<string, unknown>;
    if (component.type === ComponentType.Button) found.push(component);
    for (const child of (component.components as unknown[] | undefined) ?? []) visit(child);
  };
  for (const component of components as unknown[]) visit(component);
  return found;
}

void test("loads pages and reports non-HTML or untitled pages as errors", async () => {
  const target = { url: "https://news.example/post" };
  const ok = await loadWebPage(target, fetcher());
  assert.equal(ok.status, "ok");
  assert.deepEqual(await loadWebPage(target, fetcher(HTML, "application/pdf")), { status: "error", reason: "not_html" });
  assert.deepEqual(await loadWebPage(target, fetcher("<html></html>")), { status: "error", reason: "no_title" });
  assert.deepEqual(
    await loadWebPage(target, async () => ({ status: "error", reason: "http_error", statusCode: 404 })),
    { status: "error", reason: "http_error", statusCode: 404 },
  );
});

void test("builds a Components v2 card with open, show-original and AI summary buttons in order", async () => {
  const [result] = await buildWebReplyPayloads([{ url: "https://news.example/post" }], {
    fetcher: fetcher(),
    translate: async () => ({
      model: "translator",
      translations: {
        title: { shouldTranslate: true, sourceLanguage: "en", confidence: 1, translatedText: "大ニュース" },
      },
    }),
  });
  assert.equal(result?.status, "success");
  if (result?.status !== "success") return;
  const container = result.payload.components[0] as { type: number; components: Array<Record<string, unknown>> };
  assert.equal(container.type, ComponentType.Container);
  assert.equal(container.components[0]?.type, ComponentType.MediaGallery);
  assert.match(JSON.stringify(container), /大ニュース/);
  assert.deepEqual(buttons(result.payload.components).map((button) => [button.label, button.style, button.url ?? button.custom_id]), [
    ["リンクを開く", ButtonStyle.Link, "https://news.example/post"],
    ["原文を表示", ButtonStyle.Secondary, PREVIEW_SHOW_ORIGINAL_ID],
    ["AI要約", ButtonStyle.Primary, PREVIEW_SUMMARY_ID],
  ]);
  assert.equal(result.payload.previewState?.document.source, "web");
});

void test("omits the show-original button when nothing was translated", async () => {
  const [result] = await buildWebReplyPayloads([{ url: "https://news.example/post" }], {
    fetcher: fetcher(),
    translate: async () => ({ translations: {} }),
  });
  assert.equal(result?.status, "success");
  if (result?.status !== "success") return;
  assert.deepEqual(buttons(result.payload.components).map((button) => button.label), ["リンクを開く", "AI要約"]);
  assert.equal(result.payload.previewState, undefined);
});

void test("sends only successful cards under stable web keys and saves translated state", async () => {
  const [success] = await buildWebReplyPayloads([{ url: "https://news.example/post" }], {
    fetcher: fetcher(),
    translate: async () => ({
      translations: { title: { shouldTranslate: true, sourceLanguage: "en", confidence: 1, translatedText: "大ニュース" } },
    }),
  });
  const sent: Array<{ key: string; payload: Record<string, unknown> }> = [];
  const saved: unknown[] = [];
  await sendWebLinkExpansion({ guildId: "guild", channelId: "channel" } as never, [
    { target: { url: "https://down.example/" }, status: "error", reason: "timeout" },
    success!,
  ], {
    db: {} as never,
    log: { warn() {} },
    replyExpansion: async (_message, key, payload) => {
      sent.push({ key, payload: payload as Record<string, unknown> });
      return { id: "reply-1" } as never;
    },
    saveState: async (_db, state) => { saved.push(state); },
  });
  assert.deepEqual(sent.map((entry) => entry.key), ["web:1"]);
  assert.equal("previewState" in sent[0]!.payload, false);
  assert.equal((saved[0] as { messageId: string }).messageId, "reply-1");
});

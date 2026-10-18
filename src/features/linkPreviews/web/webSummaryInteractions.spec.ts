import assert from "node:assert/strict";
import { test } from "node:test";
import { ButtonStyle, ComponentType, MessageFlags } from "discord.js";
import { PREVIEW_SUMMARY_ID } from "../shared/previewRenderer.js";
import type { PreviewSummaryDecision } from "../shared/previewSummaryGate.js";
import { PreviewSummaryError } from "../shared/previewSummaryGate.js";
import { firstLinkButtonUrl, handleWebSummaryInteraction } from "./webSummaryInteractions.js";
import type { WebPageFetcher } from "./webPageFetcher.js";

const PAGE_URL = "https://news.example/post";

const ctx = {
  config: { GUILD_ID: "guild", DEEPSEEK_API_KEY: "key" },
  client: { user: { id: "bot" } },
  log: { warn() {} },
} as never;

function card(url = PAGE_URL) {
  return [{
    toJSON: () => ({
      type: ComponentType.Container,
      components: [{
        type: ComponentType.ActionRow,
        components: [
          { type: ComponentType.Button, style: ButtonStyle.Link, label: "リンクを開く", url },
          { type: ComponentType.Button, style: ButtonStyle.Primary, label: "AI要約", custom_id: PREVIEW_SUMMARY_ID },
        ],
      }],
    }),
  }];
}

function interaction(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; payload?: unknown }> = [];
  const value = {
    customId: PREVIEW_SUMMARY_ID,
    guildId: "guild",
    deferred: false,
    replied: false,
    message: { id: "card-1", author: { id: "bot" }, components: card() },
    async deferReply(payload: unknown) { calls.push({ method: "deferReply", payload }); value.deferred = true; },
    async editReply(payload: unknown) { calls.push({ method: "editReply", payload }); },
    async reply(payload: unknown) { calls.push({ method: "reply", payload }); value.replied = true; },
    async followUp(payload: unknown) { calls.push({ method: "followUp", payload }); },
    ...overrides,
  };
  return { value, calls };
}

const pageFetcher: WebPageFetcher = async (url) => ({
  status: "ok",
  response: {
    status: 200, finalUrl: url, contentType: "text/html",
    body: Buffer.from("<html><head><title>Big News</title></head><body><p>Body text</p></body></html>"),
  },
});

function editedText(calls: Array<{ method: string; payload?: unknown }>): string {
  const edit = calls.find((call) => call.method === "editReply")?.payload as { components?: unknown; flags?: unknown };
  assert.equal(edit.flags, MessageFlags.IsComponentsV2);
  return JSON.stringify(edit.components);
}

void test("finds the open button URL on the card", () => {
  assert.equal(firstLinkButtonUrl(card()), PAGE_URL);
  assert.equal(firstLinkButtonUrl([]), undefined);
});

void test("ignores other buttons and cards that the bot did not send", async () => {
  assert.equal(await handleWebSummaryInteraction(interaction({ customId: "other" }).value as never, ctx), false);
  const foreign = interaction({ message: { id: "x", author: { id: "someone" }, components: card() } });
  assert.equal(await handleWebSummaryInteraction(foreign.value as never, ctx), false);
  assert.equal(foreign.calls.length, 0);
});

void test("summarizes the page privately and caches the result", async () => {
  const saved: Array<[string, PreviewSummaryDecision]> = [];
  const inputs: unknown[] = [];
  const { value, calls } = interaction();
  assert.equal(await handleWebSummaryInteraction(value as never, ctx, {
    fetcher: pageFetcher,
    getSummary: async () => null,
    saveSummary: async (url, decision) => { saved.push([url, decision]); },
    summarize: async (input) => {
      inputs.push(input);
      return { shouldSummarize: true, summary: "- 要点", model: "summary-model" };
    },
  }), true);
  assert.deepEqual(calls[0], { method: "deferReply", payload: { flags: MessageFlags.Ephemeral } });
  const text = editedText(calls);
  assert.match(text, /AI要約/);
  assert.match(text, /- 要点/);
  assert.match(text, /summary-model/);
  assert.equal((inputs[0] as { title: string }).title, "Big News");
  assert.match((inputs[0] as { text: string }).text, /Body text/);
  assert.deepEqual(saved, [[PAGE_URL, { shouldSummarize: true, summary: "- 要点", model: "summary-model" }]]);
});

void test("reuses a cached summary without fetching the page", async () => {
  const { value, calls } = interaction();
  await handleWebSummaryInteraction(value as never, ctx, {
    fetcher: async () => { throw new Error("should not fetch"); },
    getSummary: async () => ({ shouldSummarize: false, summary: "" }),
  });
  assert.match(editedText(calls), /要約できる本文が見つかりませんでした/);
});

void test("explains fetch and AI failures without caching them", async () => {
  let saves = 0;
  const failedFetch = interaction();
  await handleWebSummaryInteraction(failedFetch.value as never, ctx, {
    fetcher: async () => ({ status: "error", reason: "timeout" }),
    getSummary: async () => null,
    saveSummary: async () => { saves += 1; },
  });
  assert.match(editedText(failedFetch.calls), /ページを取得できなかった/);

  const failedAi = interaction();
  await handleWebSummaryInteraction(failedAi.value as never, ctx, {
    fetcher: pageFetcher,
    getSummary: async () => null,
    saveSummary: async () => { saves += 1; },
    summarize: async () => { throw new PreviewSummaryError("down"); },
  });
  assert.match(editedText(failedAi.calls), /AIによる要約に失敗しました/);
  assert.equal(saves, 0);
});

void test("tells the user when the card has no summarizable link", async () => {
  const { value, calls } = interaction({
    message: { id: "card-2", author: { id: "bot" }, components: card("https://x.com/user/status/1") },
  });
  assert.equal(await handleWebSummaryInteraction(value as never, ctx), true);
  assert.deepEqual(calls.map((call) => call.method), ["reply"]);
});

void test("resolves the deferred response when an unexpected error happens", async () => {
  const { value, calls } = interaction();
  await handleWebSummaryInteraction(value as never, ctx, {
    getSummary: async () => { throw new Error("database down"); },
  });
  assert.deepEqual(calls.map((call) => call.method), ["deferReply", "editReply"]);
  assert.match(editedText(calls), /要約の表示に失敗しました/);

  const fallback = interaction({ async editReply() { throw new Error("edit failed"); } });
  await handleWebSummaryInteraction(fallback.value as never, ctx, {
    getSummary: async () => { throw new Error("database down"); },
  });
  assert.deepEqual(fallback.calls.map((call) => call.method), ["deferReply", "followUp"]);
});

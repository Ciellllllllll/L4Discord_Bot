import assert from "node:assert/strict";
import { test } from "node:test";
import type { AiProviderRouter, AiRouterChatOptions, AiTask } from "../../ai/aiProviderRouter.js";
import type { ChatMessage } from "../../ai/chatTypes.js";
import { PreviewSummaryError, summarizePreviewContent } from "./previewSummaryGate.js";

const input = { url: "https://news.example/post", title: "Big News", text: "Something happened today." };

function router(content: string | Error, seen: { task?: AiTask; options?: AiRouterChatOptions; messages?: ChatMessage[] } = {}) {
  return {
    async chat(_guildId: string, task: AiTask, messages: ChatMessage[], options: AiRouterChatOptions) {
      seen.task = task;
      seen.options = options;
      seen.messages = messages;
      if (content instanceof Error) throw content;
      return { content, ms: 1, model: "summary-model", provider: "deepseek" };
    },
  } as unknown as AiProviderRouter;
}

void test("routes the summary through the preview_summary task and returns the Japanese summary", async () => {
  const seen: Parameters<typeof router>[1] = {};
  const decision = await summarizePreviewContent(input, {
    config: { DEEPSEEK_API_KEY: "key", AI_REQUEST_TIMEOUT_MS: 60_000 },
    guildId: "guild",
    router: router("```json\n{\"shouldSummarize\":true,\"summary\":\"- 今日何かが起きた\"}\n```", seen),
  });
  assert.deepEqual(decision, { shouldSummarize: true, summary: "- 今日何かが起きた", model: "summary-model" });
  assert.equal(seen.task, "preview_summary");
  assert.equal(seen.options?.timeoutMs, 30_000);
  // ページの内容は指示ではなくデータとして渡す
  assert.match(String(seen.messages?.[0]?.content), /untrusted data/);
  assert.equal(JSON.parse(String(seen.messages?.[1]?.content)).text, input.text);
});

void test("treats pages judged unsummarizable or empty as having no summary", async () => {
  const deps = { config: { DEEPSEEK_API_KEY: "key" }, guildId: "guild" };
  assert.deepEqual(
    await summarizePreviewContent(input, { ...deps, router: router("{\"shouldSummarize\":false,\"summary\":\"login\"}") }),
    { shouldSummarize: false, summary: "" },
  );
  assert.deepEqual(
    await summarizePreviewContent(input, { ...deps, router: router("{\"shouldSummarize\":true,\"summary\":\"  \"}") }),
    { shouldSummarize: false, summary: "" },
  );
  let called = false;
  assert.deepEqual(await summarizePreviewContent({ url: input.url, text: " " }, {
    ...deps,
    router: { chat: async () => { called = true; throw new Error("unused"); } } as unknown as AiProviderRouter,
  }), { shouldSummarize: false, summary: "" });
  assert.equal(called, false);
});

void test("truncates long summaries and reports request and JSON failures as errors", async () => {
  const deps = { config: { DEEPSEEK_API_KEY: "key" }, guildId: "guild" };
  const long = await summarizePreviewContent(input, {
    ...deps, router: router(JSON.stringify({ shouldSummarize: true, summary: "あ".repeat(3_000) })),
  });
  assert.equal(long.summary.length, 1_500);
  await assert.rejects(summarizePreviewContent(input, { ...deps, router: router(new Error("down")) }), PreviewSummaryError);
  await assert.rejects(summarizePreviewContent(input, { ...deps, router: router("not json") }), PreviewSummaryError);
});

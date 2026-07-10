import assert from "node:assert/strict";
import { AiRequestError } from "./aiRequestError.js";
import { openAiResponsesChat } from "./openaiResponses.js";

type FetchCall = { url: string; init: RequestInit };

function config() {
  return {
    apiKey: "openai-secret",
    apiBase: "https://api.openai.test/v1/",
    model: "gpt-5.6-terra",
    reasoningEffort: "high" as const,
    timeoutMs: 10_000,
    maxResponseBytes: 64_000,
  };
}

async function run(): Promise<void> {
  const calls: FetchCall[] = [];
  const result = await openAiResponsesChat(
    config(),
    [
      { role: "system", content: "System A" },
      { role: "system", content: "System B" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "previous" },
      { role: "user", content: "next" },
    ],
    {
      thinking: true,
      maxOutputTokens: 4096,
    },
    {
      fetcher: async (url, init) => {
        calls.push({ url, init });
        return Response.json({
          model: "gpt-5.6-terra-response-snapshot",
          output: [{ content: [{ type: "output_text", text: "hello @everyone <@123>" }] }],
          usage: { total_tokens: 321 },
        });
      },
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api.openai.test/v1/responses");
  assert.equal(new Headers(calls[0]?.init.headers).get("authorization"), "Bearer openai-secret");
  const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
  assert.equal(body.model, "gpt-5.6-terra");
  assert.equal(body.instructions, "System A\n\nSystem B");
  assert.deepEqual(body.reasoning, { effort: "high" });
  assert.equal(body.max_output_tokens, 4096);
  assert.equal("temperature" in body, false);
  assert.deepEqual(body.input, [
    { role: "user", content: "hello" },
    { role: "assistant", content: "previous" },
    { role: "user", content: "next" },
  ]);
  assert.equal(result.content, "hello @\u200beveryone <@\u200b123>");
  assert.equal(result.usageTotalTokens, 321);
  assert.equal(result.model, "gpt-5.6-terra-response-snapshot");

  const noThinkingBodies: Array<Record<string, unknown>> = [];
  const noThinkingResult = await openAiResponsesChat(
    config(),
    [{ role: "user", content: "ping" }],
    { thinking: false, maxOutputTokens: 64, sanitizeOutput: false },
    {
      fetcher: async (_url, init) => {
        noThinkingBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return Response.json({ output_text: " raw ", usage: { total_tokens: 2 } });
      },
    },
  );
  assert.deepEqual(noThinkingBodies[0]?.reasoning, { effort: "none" });
  assert.equal(noThinkingResult.model, "gpt-5.6-terra");

  await assert.rejects(
    openAiResponsesChat(config(), [{ role: "user", content: "x" }], { thinking: false, maxOutputTokens: 64 }, {
      fetcher: async () => Response.json({ error: { code: "model_not_found" } }, { status: 404 }),
    }),
    (err: unknown) => err instanceof AiRequestError
      && err.kind === "http_status"
      && err.status === 404
      && err.apiCode === "model_not_found",
  );

  await assert.rejects(
    openAiResponsesChat(config(), [{ role: "user", content: "x" }], { thinking: false, maxOutputTokens: 64 }, {
      fetcher: async () => new Response("rate limited", { status: 429 }),
    }),
    (err: unknown) => err instanceof AiRequestError
      && err.kind === "http_status"
      && err.status === 429
      && err.cause === undefined,
  );

  await assert.rejects(
    openAiResponsesChat(config(), [{ role: "user", content: "x" }], { thinking: false, maxOutputTokens: 64 }, {
      fetcher: async () => Response.json({ output: [], usage: { total_tokens: 19 } }),
    }),
    (err: unknown) => err instanceof AiRequestError
      && err.kind === "invalid_response"
      && err.usageTotalTokens === 19,
  );

  const timeoutOptions: number[] = [];
  await openAiResponsesChat(
    config(),
    [{ role: "user", content: "timeout override" }],
    { thinking: false, maxOutputTokens: 64, timeoutMs: 1_234 },
    {
      fetcher: async (_url, _init, options) => {
        timeoutOptions.push(options.timeoutMs);
        return Response.json({ output_text: "ok", usage: { total_tokens: 2 } });
      },
    },
  );
  assert.deepEqual(timeoutOptions, [1_234]);

  const callerController = new AbortController();
  callerController.abort();
  await assert.rejects(
    openAiResponsesChat(config(), [{ role: "user", content: "x" }], {
      thinking: false,
      maxOutputTokens: 64,
      signal: callerController.signal,
    }, {
      fetcher: async () => { throw new DOMException("aborted", "AbortError"); },
    }),
    (err: unknown) => err instanceof AiRequestError && err.kind === "caller_abort",
  );

  await assert.rejects(
    openAiResponsesChat(config(), [{ role: "user", content: "x" }], { thinking: false, maxOutputTokens: 64 }, {
      fetcher: async () => { throw new DOMException("timed out", "AbortError"); },
    }),
    (err: unknown) => err instanceof AiRequestError && err.kind === "timeout",
  );
}

void run()
  .then(() => console.log("openaiResponses.spec.ts: all assertions passed"))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

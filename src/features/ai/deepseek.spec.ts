import assert from "node:assert/strict";
import type { AppConfig } from "../../core/config.js";
import { deepseekChat } from "./deepseek.js";

function testConfig(): AppConfig {
  return {
    DEEPSEEK_API_KEY: "deepseek-secret",
    DEEPSEEK_API_BASE: "https://deepseek.test/v1",
    DEEPSEEK_MODEL: "deepseek-request-model",
    DEEPSEEK_THINKING_ENABLED: false,
    DEEPSEEK_THINKING_EFFORT: "high",
    AI_TEMPERATURE: 0,
    AI_REQUEST_TIMEOUT_MS: 10_000,
    AI_MAX_RETRIES: 0,
    AI_MAX_RESPONSE_BYTES: 64_000,
  } as AppConfig;
}

async function run(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const requestModels: string[] = [];

  try {
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      requestModels.push(body.model);
      return Response.json({
        model: "deepseek-response-model",
        choices: [{ message: { content: "answer" } }],
      });
    }) as typeof fetch;

    const responseModel = await deepseekChat(
      testConfig(),
      [{ role: "user", content: "hello" }],
      { maxRetries: 0 },
    );
    assert.equal(responseModel.model, "deepseek-response-model");

    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      requestModels.push(body.model);
      return Response.json({ choices: [{ message: { content: "fallback" } }] });
    }) as typeof fetch;

    const requestedModel = await deepseekChat(
      testConfig(),
      [{ role: "user", content: "hello" }],
      { model: "deepseek-override", maxRetries: 0 },
    );
    assert.equal(requestedModel.model, "deepseek-override");
    assert.deepEqual(requestModels, ["deepseek-request-model", "deepseek-override"]);

    globalThis.fetch = (async () => new Response("reflected-private-prompt", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
    await assert.rejects(
      () => deepseekChat(testConfig(), [{ role: "user", content: "hello" }], { maxRetries: 0 }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "DeepSeek returned invalid JSON");
        assert.equal(error.message.includes("reflected-private-prompt"), false);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

void run()
  .then(() => console.log("deepseek.spec.ts: all assertions passed"))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

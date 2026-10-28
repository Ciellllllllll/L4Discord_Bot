import assert from "node:assert/strict";
import type { AppConfig } from "../../core/config.js";
import { AiRequestError } from "./aiRequestError.js";
import { openRouterChat } from "./openrouter.js";

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    OPENROUTER_API_KEY: "openrouter-secret",
    OPENROUTER_API_BASE: "https://openrouter.test/api/v1",
    OPENROUTER_MODEL: "openai/gpt-4.1-mini",
    AI_TEMPERATURE: 0.3,
    AI_REQUEST_TIMEOUT_MS: 10_000,
    AI_MAX_RETRIES: 0,
    AI_MAX_RESPONSE_BYTES: 64_000,
    ...overrides,
  } as AppConfig;
}

async function run(): Promise<void> {
  const originalFetch = globalThis.fetch;

  try {
    const urls: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    const authHeaders: Array<string | null> = [];

    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      urls.push(String(input));
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      authHeaders.push(new Headers(init?.headers).get("Authorization"));
      return Response.json({
        model: "openai/gpt-4.1-mini-response",
        choices: [{ message: { content: "answer" } }],
        usage: { total_tokens: 42 },
      });
    }) as typeof fetch;

    const result = await openRouterChat(
      testConfig(),
      [{ role: "user", content: "hello" }],
      { maxRetries: 0 },
    );

    assert.equal(urls[0], "https://openrouter.test/api/v1/chat/completions");
    assert.equal(authHeaders[0], "Bearer openrouter-secret");
    assert.equal(bodies[0]?.model, "openai/gpt-4.1-mini");
    assert.equal(bodies[0]?.temperature, 0.3);
    assert.deepEqual(bodies[0]?.messages, [{ role: "user", content: "hello" }]);
    assert.equal(result.model, "openai/gpt-4.1-mini-response");
    assert.equal(result.content, "answer");
    assert.equal(result.usageTotalTokens, 42);

    await assert.rejects(
      () => openRouterChat(testConfig({ OPENROUTER_API_KEY: "" }), [{ role: "user", content: "x" }]),
      (error: unknown) => error instanceof AiRequestError && error.kind === "configuration",
    );

    globalThis.fetch = (async () => new Response("reflected-private-prompt", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
    await assert.rejects(
      () => openRouterChat(testConfig(), [{ role: "user", content: "x" }], { maxRetries: 0 }),
      (error: unknown) => {
        assert.ok(error instanceof AiRequestError);
        assert.equal(error.kind, "invalid_response");
        assert.equal(error.message.includes("reflected-private-prompt"), false);
        return true;
      },
    );

    globalThis.fetch = (async () => new Response("upstream error detail", { status: 429 })) as typeof fetch;
    await assert.rejects(
      () => openRouterChat(testConfig(), [{ role: "user", content: "x" }], { maxRetries: 0 }),
      (error: unknown) => {
        assert.ok(error instanceof AiRequestError);
        assert.equal(error.kind, "http_status");
        assert.equal(error.status, 429);
        assert.equal(error.message.includes("upstream error detail"), false);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

void run()
  .then(() => console.log("openrouter.spec.ts: all assertions passed"))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

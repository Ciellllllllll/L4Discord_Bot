import assert from "node:assert/strict";
import type { AppConfig } from "../../core/config.js";
import { localLlmChat } from "./localLlm.js";

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    LOCAL_LLM_API_BASE: "http://127.0.0.1:8080/v1/",
    LOCAL_LLM_API_KEY: "local-secret",
    LOCAL_LLM_MODEL: "local-model",
    LOCAL_LLM_TIMEOUT_MS: 12345,
    LOCAL_LLM_TEMPERATURE: 0.4,
    AI_MAX_RESPONSE_BYTES: 64_000,
    ...overrides,
  } as AppConfig;
}

async function run(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: input.toString(), init: init ?? {} });
    return Response.json({
      model: "local-response-model",
      choices: [{ message: { content: "  local answer  " } }],
    });
  }) as typeof fetch;

  try {
    const result = await localLlmChat(
      testConfig(),
      [{ role: "user", content: "hello" }],
      { temperature: 0.2 },
    );

    assert.equal(result.content, "local answer");
    assert.equal(result.model, "local-response-model");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "http://127.0.0.1:8080/v1/chat/completions");
    assert.equal(calls[0]?.init.method, "POST");
    assert.equal((calls[0]?.init.headers as Record<string, string>).Authorization, "Bearer local-secret");
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    assert.deepEqual(body, {
      model: "local-model",
      temperature: 0.2,
      messages: [{ role: "user", content: "hello" }],
    });
    assert.equal(Object.hasOwn(body, "thinking"), false);
    assert.equal(Object.hasOwn(body, "reasoning_effort"), false);

    globalThis.fetch = (async () =>
      Response.json({
        choices: [{ message: { content: "@everyone @here <@123> <@!456> <@&789>" } }],
      })) as typeof fetch;
    const sanitized = await localLlmChat(testConfig(), [{ role: "user", content: "mention test" }]);
    assert.equal(sanitized.model, "local-model");
    assert.equal(sanitized.content.includes("@everyone"), false);
    assert.equal(sanitized.content.includes("@here"), false);
    assert.equal(sanitized.content.includes("<@123>"), false);
    assert.equal(sanitized.content.includes("<@!456>"), false);
    assert.equal(sanitized.content.includes("<@&789>"), false);

    for (const config of [
      testConfig({ LOCAL_LLM_API_BASE: undefined }),
      testConfig({ LOCAL_LLM_API_KEY: "" }),
    ]) {
      await assert.rejects(
        () => localLlmChat(config, [{ role: "user", content: "hello" }]),
        (err) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /LOCAL_LLM_(API_BASE|API_KEY)/);
          assert.equal(err.message.includes("local-secret"), false);
          assert.equal(err.message.includes("Bearer"), false);
          return true;
        },
      );
    }

    globalThis.fetch = (async () =>
      new Response("reflected-private-prompt local-secret Bearer x http://local.test/v1 local.test", { status: 500 })) as typeof fetch;
    await assert.rejects(
      () =>
        localLlmChat(
          testConfig({ LOCAL_LLM_API_BASE: "http://local.test/v1" }),
          [{ role: "user", content: "hello" }],
        ),
      (err) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, "Local LLM HTTP 500");
        assert.equal(err.message.includes("reflected-private-prompt"), false);
        assert.equal(err.message.includes("local-secret"), false);
        assert.equal(err.message.includes("Bearer"), false);
        assert.equal(err.message.includes("http://local.test/v1"), false);
        assert.equal(err.message.includes("local.test"), false);
        return true;
      },
    );

    globalThis.fetch = (async () => new Response("reflected-private-prompt", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
    await assert.rejects(
      () => localLlmChat(testConfig(), [{ role: "user", content: "hello" }]),
      (err) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, "Local LLM returned invalid JSON");
        assert.equal(err.message.includes("reflected-private-prompt"), false);
        return true;
      },
    );

    globalThis.fetch = (async () =>
      Response.json({
        choices: [{ message: { content: "x".repeat(1_000) } }],
      })) as typeof fetch;
    await assert.rejects(
      () =>
        localLlmChat(
          testConfig({ AI_MAX_RESPONSE_BYTES: 32 }),
          [{ role: "user", content: "hello" }],
        ),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /HTTP response too large/);
        return true;
      },
    );

    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const signal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }) as typeof fetch;
    const controller = new AbortController();
    const aborted = localLlmChat(
      testConfig({ LOCAL_LLM_TIMEOUT_MS: 10_000 }),
      [{ role: "user", content: "abort test" }],
      { signal: controller.signal },
    );
    controller.abort(new Error("external abort"));
    await assert.rejects(
      () => aborted,
      (err) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, "external abort");
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

void run()
  .then(() => {
    console.log("localLlm.spec.ts: all assertions passed");
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

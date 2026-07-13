import assert from "node:assert/strict";
import { analyzeMorph, analyzeSenryu, checkJapaneseWorkerHealth } from "./japaneseAnalysisClient.js";

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

async function run(): Promise<void> {
  const okSenryu = await analyzeSenryu("古池や蛙飛び込む水の音", {
    baseUrl: "http://127.0.0.1:8787",
    timeoutMs: 100,
    fetchImpl: async () => jsonResponse({
      matched: true,
      text: "古池や 蛙飛び込む 水の音",
      phrases: ["古池や", "蛙飛び込む", "水の音"],
      error: null,
    }),
  });
  assert.equal(okSenryu.ok, true);
  assert.equal(okSenryu.ok ? okSenryu.data.matched : false, true);

  const invalidJson = await analyzeMorph("原神", {
    baseUrl: "http://127.0.0.1:8787",
    timeoutMs: 100,
    fetchImpl: async () => new Response("{", { status: 200 }),
  });
  assert.equal(invalidJson.ok, false);
  assert.equal(invalidJson.ok ? "" : invalidJson.reason, "invalid_json");

  const invalidResponse = await analyzeMorph("原神", {
    baseUrl: "http://127.0.0.1:8787",
    timeoutMs: 100,
    fetchImpl: async () => jsonResponse({ tokens: [{}], error: null }),
  });
  assert.equal(invalidResponse.ok, false);
  assert.equal(invalidResponse.ok ? "" : invalidResponse.reason, "invalid_response");

  const httpError = await analyzeSenryu("x", {
    baseUrl: "http://127.0.0.1:8787",
    timeoutMs: 100,
    fetchImpl: async () => jsonResponse({ error: "bad" }, { status: 500 }),
  });
  assert.equal(httpError.ok, false);
  assert.equal(httpError.ok ? "" : httpError.reason, "http_error");

  const timeout = await analyzeSenryu("x", {
    baseUrl: "http://127.0.0.1:8787",
    timeoutMs: 1,
    fetchImpl: (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }),
  });
  assert.equal(timeout.ok, false);
  assert.equal(timeout.ok ? "" : timeout.reason, "timeout");

  const health = await checkJapaneseWorkerHealth({
    baseUrl: "http://127.0.0.1:8787",
    timeoutMs: 100,
    fetchImpl: async () => jsonResponse({ ok: true }),
  });
  assert.equal(health.ok, true);
  assert.equal(health.ok ? health.data.ok : false, true);

  const badHealth = await checkJapaneseWorkerHealth({
    baseUrl: "http://127.0.0.1:8787",
    timeoutMs: 100,
    fetchImpl: async () => jsonResponse({ ok: false }),
  });
  assert.equal(badHealth.ok, false);
  assert.equal(badHealth.ok ? "" : badHealth.reason, "invalid_response");
}

void run()
  .then(() => {
    console.log("japaneseAnalysisClient.spec.ts: all assertions passed");
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

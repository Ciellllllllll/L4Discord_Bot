import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import type { PacchiRepositoryLike } from "./pacchi.repository.js";
import { buildPacchiChatReply, tinyAiPrompt } from "./pacchi.tinyAi.js";

const repo = { pickWord: async () => null } as unknown as PacchiRepositoryLike;
const warnings: string[] = [];
const log = { warn: (_fields: Record<string, unknown>, message: string) => { warnings.push(message); } };
const options = {
  PACCHI_GENERATION_MODE: "tiny-ai" as const,
  PACCHI_TINY_AI_URL: "http://127.0.0.1:8790",
  PACCHI_TINY_AI_TIMEOUT_MS: 100,
};

async function withFetch(fetchImpl: typeof fetch, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try { await fn(); } finally { globalThis.fetch = original; }
}

async function run(): Promise<void> {
  assert.equal(tinyAiPrompt("ぱっちぃ  明日は\n"), "明日は");
  assert.equal(tinyAiPrompt("ぱっちぃ <@123456789>"), "");
  assert.equal(tinyAiPrompt("ぱっちぃ https://example.com"), "");
  assert.equal(Array.from(tinyAiPrompt("ぱっちぃ " + "あ".repeat(100))).length, 48);
  await withFetch(async (url, init) => {
    assert.equal(String(url), "http://127.0.0.1:8790/generate");
    assert.deepEqual(JSON.parse(String(init?.body)), { prompt: "明日は" });
    return Response.json({ text: "明日は無理だよ" });
  }, async () => {
    assert.equal(await buildPacchiChatReply(repo, "guild", options, "ぱっちぃ 明日は", log), "明日は無理だよ");
  });

  for (const response of [
    Response.json({ text: "private-output" }, { status: 503 }),
    new Response("bad JSON"), Response.json({ text: 123 }),
    Response.json({ text: "" }), Response.json({ text: "明日は" }),
    Response.json({ text: "https://example.com" }), Response.json({ text: "@everyone" }),
    Response.json({ text: "死ね" }), Response.json({ text: "a".repeat(161) }),
  ]) {
    await withFetch(async () => response, async () => {
      const reply = await buildPacchiChatReply(repo, "guild", options, "ぱっちぃ 明日は", log);
      assert.ok(reply.trim());
      assert.notEqual(reply, "明日は");
      assert.ok(!reply.includes("private-output"));
    });
  }
  await withFetch(async () => { throw new Error("private error"); }, async () => {
    assert.ok(await buildPacchiChatReply(repo, "guild", options, "ぱっちぃ", log));
  });
  await withFetch(async () => { throw new Error("legacy mode must not request AI"); }, async () => {
    const count = warnings.length;
    assert.ok(await buildPacchiChatReply(repo, "guild", { ...options, PACCHI_GENERATION_MODE: "template" }, "ぱっちぃ", log));
    assert.equal(warnings.length, count);
  });

  let release: (() => void) | undefined;
  let calls = 0;
  await withFetch(async () => {
    calls++;
    await new Promise<void>((resolve) => { release = resolve; });
    return Response.json({ text: "できたよ" });
  }, async () => {
    const first = buildPacchiChatReply(repo, "guild", options, "ぱっちぃ", log);
    assert.ok(await buildPacchiChatReply(repo, "other", options, "ぱっちぃ", log));
    assert.equal(calls, 1);
    release!();
    assert.equal(await first, "できたよ");
  });

  const server = createServer(() => { /* Deliberately never respond. */ });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    assert.ok(await buildPacchiChatReply(repo, "timeout", {
      ...options, PACCHI_TINY_AI_URL: `http://127.0.0.1:${address.port}`,
    }, "ぱっちぃ", log));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  assert.ok(!warnings.join(" ").includes("private"));
}

void run().then(() => console.log("pacchi.tinyAi.spec.ts: all assertions passed"))
  .catch((error) => { console.error(error); process.exit(1); });

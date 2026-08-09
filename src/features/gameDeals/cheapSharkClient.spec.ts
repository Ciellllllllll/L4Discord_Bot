import assert from "node:assert/strict";
import { test } from "node:test";
import { CheapSharkClient, CheapSharkHttpError } from "./cheapSharkClient.js";

function logStub(warnings: unknown[][] = []) {
  return { warn: (...args: unknown[]) => { warnings.push(args); } } as never;
}

test("saved CheapShark cooldown skips the HTTP request", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const client = new CheapSharkClient(logStub(), { cooldownUntil: new Date(Date.now() + 60_000).toISOString() });
    assert.deepEqual(await client.fetchSteamDealsByAppId("130"), []);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("429 sets a default cooldown and suppresses the next request", async () => {
  const originalFetch = globalThis.fetch;
  const warnings: unknown[][] = [];
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('{"error":"blocked"}', { status: 429 });
  };
  try {
    const client = new CheapSharkClient(logStub(warnings));
    await assert.rejects(
      client.fetchSteamDealsByAppId("130"),
      (err: unknown) => err instanceof CheapSharkHttpError && err.status === 429,
    );
    const cooldownUntil = client.getCooldownUntil();
    assert.ok(cooldownUntil);
    assert.ok(Date.parse(cooldownUntil) >= Date.now() + 29 * 60_000);
    assert.deepEqual(await client.fetchSteamDealsByAppId("130"), []);
    assert.equal(calls, 1);
    assert.deepEqual(warnings, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

import assert from "node:assert/strict";
import { loadConfig } from "../../core/config.js";
import { startJapaneseWorkerIfEnabled } from "./japaneseWorkerProcess.js";
import type { AppConfig } from "../../core/config.js";

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DISCORD_TOKEN: "token",
    DISCORD_CLIENT_ID: "client",
    GUILD_ID: "guild",
    OWNER_ID: "owner",
    ADMIN_ROLE_ID: "admin",
    DB_DRIVER: "postgres",
    DATABASE_URL: "postgres://user:pass@127.0.0.1:5432/l4discord_test",
    ...overrides,
  };
}

function log() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

async function withFetch<T>(fetchImpl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function run(): Promise<void> {
  const aliasConfig = loadConfig(baseEnv({ JAPANESE_WORKER_ENABLED: "", WORKER_ENABLED: "on" }));
  assert.equal(aliasConfig.JAPANESE_WORKER_ENABLED, true);

  const disabled = await startJapaneseWorkerIfEnabled(
    { JAPANESE_WORKER_ENABLED: false } as AppConfig,
    log(),
  );
  assert.equal(disabled.started, false);
  await disabled.stop();

  await withFetch(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }), async () => {
    const existing = await startJapaneseWorkerIfEnabled(
      {
        JAPANESE_WORKER_ENABLED: true,
        JAPANESE_WORKER_URL: "http://127.0.0.1:8787",
        JAPANESE_WORKER_TIMEOUT_MS: 100,
      } as AppConfig,
      log(),
    );
    assert.equal(existing.started, false);
    await existing.stop();
  });
}

void run()
  .then(() => {
    console.log("japaneseWorkerProcess.spec.ts: all assertions passed");
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

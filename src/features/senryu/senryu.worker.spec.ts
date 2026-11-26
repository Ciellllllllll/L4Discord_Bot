import assert from "node:assert/strict";
import { ChannelType } from "discord.js";
import type { Message } from "discord.js";
import { initKuromojiTokenizer } from "./senryu.kuromoji.js";
import { runSenryuPipeline } from "./senryu.service.js";
import type { SenryuServiceDeps } from "./senryu.service.js";
import type { SenryuRepository } from "./senryu.repository.js";
import type { SenryuRecord, SavedSenryuRecord } from "./senryu.types.js";

function makeMessage(content: string): Message {
  return {
    id: "message",
    guildId: "guild",
    guild: { id: "guild" },
    channelId: "channel",
    channel: {
      id: "channel",
      type: ChannelType.GuildText,
      isThread: () => false,
    },
    author: {
      id: "author",
      bot: false,
    },
    content,
  } as unknown as Message;
}

function makeCtx(timeoutMs = 100, workerFallbackEnabled = false): SenryuServiceDeps {
  const logs: unknown[] = [];
  return {
    config: {
      GUILD_ID: "guild",
      SENRYU_ENABLED: true,
      SENRYU_MAX_CONTENT_LENGTH: 2000,
      SENRYU_DETECTOR_MODE: "go-worker",
      SENRYU_WORKER_FALLBACK_ENABLED: workerFallbackEnabled,
      SENRYU_WORKER_FALLBACK_ON_NO_MATCH: false,
      SENRYU_MORA_TOLERANCE: 0,
      SENRYU_BEST_CANDIDATE: false,
      SENRYU_JS_HAIKU_VERIFY_ENABLED: true,
      SENRYU_AI_REVIEW_ENABLED: true,
      SENRYU_SAVE_ENABLED: false,
      SENRYU_REPLY_ENABLED: false,
      SENRYU_AUTO_MUTE_ON_PERMISSION_ERROR: true,
      JAPANESE_WORKER_ENABLED: true,
      JAPANESE_WORKER_URL: "http://127.0.0.1:8787",
      JAPANESE_WORKER_TIMEOUT_MS: timeoutMs,
    },
    log: {
      info: (...args: unknown[]) => logs.push(args),
      warn: (...args: unknown[]) => logs.push(args),
      error: (...args: unknown[]) => logs.push(args),
    },
  } as unknown as SenryuServiceDeps;
}

function makeRepo(): SenryuRepository {
  return {
    async saveSenryu(record: SenryuRecord): Promise<SavedSenryuRecord> {
      return { ...record, id: "saved" };
    },
    async deleteSenryu(): Promise<void> {},
  };
}

function responseJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function withFetch(fetchImpl: typeof fetch, fn: () => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function run(): Promise<void> {
  await withFetch(async () => responseJson({
    matched: true,
    text: "春風に コードが揺れて バグが咲く",
    phrases: ["春風に", "コードが揺れて", "バグが咲く"],
    error: null,
  }), async () => {
    const handled = await runSenryuPipeline(makeCtx(), makeMessage("春風にコードが揺れてバグが咲く"), makeRepo());
    assert.equal(handled, true);
  });

  await withFetch(async () => responseJson({
    matched: false,
    text: null,
    phrases: [],
    error: null,
  }), async () => {
    const handled = await runSenryuPipeline(makeCtx(), makeMessage("川柳ではない"), makeRepo());
    assert.equal(handled, false);
  });

  await withFetch(async () => responseJson({ error: "bad" }, 500), async () => {
    const handled = await runSenryuPipeline(makeCtx(), makeMessage("春風にコードが揺れてバグが咲く"), makeRepo());
    assert.equal(handled, false);
  });

  await withFetch((_input, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal) {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }
  }), async () => {
    const handled = await runSenryuPipeline(makeCtx(1), makeMessage("春風にコードが揺れてバグが咲く"), makeRepo());
    assert.equal(handled, false);
  });

  await initKuromojiTokenizer(undefined, {
    info: () => undefined,
    error: () => undefined,
  } as never);
  await withFetch(async () => responseJson({
    matched: true,
    text: "bad",
    phrases: ["bad"],
    error: null,
  }), async () => {
    const handled = await runSenryuPipeline(
      makeCtx(100, true),
      makeMessage("古池や蛙飛び込む水の音"),
      makeRepo(),
    );
    assert.equal(handled, true);
  });
}

void run()
  .then(() => {
    console.log("senryu.worker.spec.ts: all assertions passed");
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

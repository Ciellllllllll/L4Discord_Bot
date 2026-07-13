import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type { Message } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { handlePacchiMessage } from "./pacchi.message-handler.js";
import { ensurePacchiSchemaOnce } from "./pacchi.schema.js";

function makeCtx(sqlite: Database.Database): BotContext {
  return {
    sqlite,
    config: {
      GUILD_ID: "guild",
      JAPANESE_WORKER_ENABLED: true,
      JAPANESE_WORKER_URL: "http://127.0.0.1:8787",
      JAPANESE_WORKER_TIMEOUT_MS: 100,
      PACCHI_LEARNING_ANALYZER: "kuromoji",
      PACCHI_PATTERN_LEARNING_ENABLED: false,
      PACCHI_GENERATION_MODE: "template",
      PACCHI_WIKIPEDIA_API_BASE_URL: "https://ja.wikipedia.org/api/rest_v1/page/summary",
    },
    log: {
      warn: () => undefined,
      error: () => undefined,
      info: () => undefined,
      debug: () => undefined,
    },
    client: {
      user: { id: "bot-user" },
    },
  } as unknown as BotContext;
}

function makeMessage(
  content: string,
  replies: string[],
  channelId = "channel",
  author = { id: "author", bot: false },
): Message {
  return {
    id: "message",
    guildId: "guild",
    channelId,
    author,
    content,
    attachments: { size: 0 },
    stickers: { values: () => [][Symbol.iterator]() },
    guild: {
      emojis: { cache: { has: () => false } },
      stickers: { cache: { has: () => false } },
    },
    reply: async (options: { content: string }) => {
      replies.push(options.content);
    },
  } as unknown as Message;
}

function responseJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
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

async function runCase(fetchImpl: typeof fetch): Promise<{
  handled: boolean;
  replies: string[];
  submissions: { formatted: string; source_content: string }[];
}> {
  const db = new Database(":memory:");
  const replies: string[] = [];
  try {
    const handled = await withFetch(fetchImpl, async () => {
      return handlePacchiMessage(
        makeCtx(db),
        makeMessage("ぱっちぃ 575\n春風に\nコードが揺れて\nバグが咲く", replies),
      );
    });
    const submissions = db.prepare(
      "SELECT formatted, source_content FROM pacchi_senryu_submissions ORDER BY created_at",
    ).all() as { formatted: string; source_content: string }[];
    return { handled, replies, submissions };
  } finally {
    db.close();
  }
}

async function runGenerationCase(fetchImpl: typeof fetch): Promise<{
  handled: boolean;
  replies: string[];
}> {
  const db = new Database(":memory:");
  const replies: string[] = [];
  try {
    const handled = await withFetch(fetchImpl, async () => {
      return handlePacchiMessage(
        makeCtx(db),
        makeMessage("ぱっちぃ 575", replies, "generation-channel"),
      );
    });
    return { handled, replies };
  } finally {
    db.close();
  }
}

async function run(): Promise<void> {
  {
    const db = new Database(":memory:");
    const replies: string[] = [];
    try {
      ensurePacchiSchemaOnce(db);
      const handled = await handlePacchiMessage(
        makeCtx(db),
        makeMessage("ぱっちぃが覚えそうな言葉", replies, "channel", { id: "bot-user", bot: false }),
      );
      assert.equal(handled, false);
      assert.deepEqual(replies, []);
      const wordCount = db.prepare("SELECT count(*) AS count FROM pacchi_words").get() as { count: number };
      assert.equal(wordCount.count, 0);
    } finally {
      db.close();
    }
  }

  const matched = await runCase(async () => responseJson({
    matched: true,
    text: "春風に コードが揺れて バグが咲く",
    phrases: ["春風に", "コードが揺れて", "バグが咲く"],
    error: null,
  }));
  assert.equal(matched.handled, true);
  assert.equal(matched.replies.length, 1);
  assert.match(matched.replies[0]!, /575/);
  assert.deepEqual(matched.submissions, [{
    formatted: "春風に コードが揺れて バグが咲く",
    source_content: "春風に\nコードが揺れて\nバグが咲く",
  }]);

  const notMatched = await runCase(async () => responseJson({
    matched: false,
    text: null,
    phrases: [],
    error: null,
  }));
  assert.equal(notMatched.handled, true);
  assert.equal(notMatched.replies.length, 1);
  assert.match(notMatched.replies[0]!, /575じゃない/);
  assert.deepEqual(notMatched.submissions, []);

  const workerError = await runCase(async () => responseJson({ error: "bad" }, 500));
  assert.equal(workerError.handled, true);
  assert.equal(workerError.replies.length, 1);
  assert.match(workerError.replies[0]!, /数えられない/);
  assert.deepEqual(workerError.submissions, []);

  const workerRequests: string[] = [];
  const generated = await runGenerationCase(async (_input, init) => {
    workerRequests.push(String(init?.body));
    return responseJson({
      matched: true,
      text: "春風に コードが揺れて バグが咲く",
      phrases: ["春風に", "コードが揺れて", "バグが咲く"],
      error: null,
    });
  });
  assert.equal(generated.handled, true);
  assert.deepEqual(generated.replies, ["春風に\nコードが揺れて\nバグが咲く"]);
  assert.equal(workerRequests.length, 16);
  assert.match(workerRequests[0]!, /"rule":\[5,7,5\]/);
}

void run()
  .then(() => {
    console.log("pacchi.submit.spec.ts: all assertions passed");
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

import assert from "node:assert/strict";
import type { Message } from "discord.js";
import type { Pool } from "pg";
import { createPgPool, quotePgIdent } from "../../core/db/postgres.js";
import { getOptionalPostgresTestUrl } from "../../test/postgresTestEnv.js";
import { handlePacchiMessage, type PacchiMessageDeps } from "./pacchi.message-handler.js";
import { ensurePostgresPacchiSchema } from "./pacchi.schema.js";
import { PostgresPacchiRepository } from "./postgresPacchiRepository.js";

function makeCtx(mainPgPool: Pool): PacchiMessageDeps {
  return {
    mainPgPool,
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
    client: { user: { id: "bot-user" } },
  } as unknown as PacchiMessageDeps;
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
    reply: async (options: { content: string }) => { replies.push(options.content); },
  } as unknown as Message;
}

function responseJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

async function withFetch<T>(fetchImpl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try { return await fn(); } finally { globalThis.fetch = originalFetch; }
}

async function runCase(pool: Pool, fetchImpl: typeof fetch): Promise<{
  handled: boolean;
  replies: string[];
  submissions: { formatted: string; source_content: string }[];
}> {
  await pool.query("DELETE FROM pacchi_senryu_submissions");
  const replies: string[] = [];
  const handled = await withFetch(fetchImpl, () => handlePacchiMessage(
    makeCtx(pool),
    makeMessage("ぱっちぃ 575\n春風に\nコードが揺れて\nバグが咲く", replies),
  ));
  const submissions = await pool.query<{ formatted: string; source_content: string }>(
    "SELECT formatted, source_content FROM pacchi_senryu_submissions ORDER BY created_at",
  );
  return { handled, replies, submissions: submissions.rows };
}

async function run(): Promise<void> {
  const connectionString = getOptionalPostgresTestUrl("TEST_DATABASE_URL", "pacchi.submit.spec.ts");
  if (!connectionString) return;
  const schemaName = `pacchi_submit_${process.pid}_${Date.now()}`;
  const pool = await createPgPool(connectionString, schemaName);
  try {
    await ensurePostgresPacchiSchema(pool);
    const replies: string[] = [];
    const handled = await handlePacchiMessage(
      makeCtx(pool),
      makeMessage("ぱっちぃが覚えそうな言葉", replies, "channel", { id: "bot-user", bot: false }),
    );
    assert.equal(handled, false);
    assert.deepEqual(replies, []);
    assert.equal(Number((await pool.query<{ count: string }>("SELECT count(*) AS count FROM pacchi_words")).rows[0]?.count), 0);

    const matched = await runCase(pool, async () => responseJson({
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

    const notMatched = await runCase(pool, async () => responseJson({ matched: false, text: null, phrases: [], error: null }));
    assert.equal(notMatched.handled, true);
    assert.match(notMatched.replies[0]!, /575じゃない/);
    assert.deepEqual(notMatched.submissions, []);

    const workerError = await runCase(pool, async () => responseJson({ error: "bad" }, 500));
    assert.equal(workerError.handled, true);
    assert.match(workerError.replies[0]!, /数えられない/);
    assert.deepEqual(workerError.submissions, []);

    const workerRequests: string[] = [];
    const generatedReplies: string[] = [];
    const generated = await withFetch(async (_input, init) => {
      workerRequests.push(String(init?.body));
      return responseJson({
        matched: true,
        text: "春風に コードが揺れて バグが咲く",
        phrases: ["春風に", "コードが揺れて", "バグが咲く"],
        error: null,
      });
    }, () => handlePacchiMessage(makeCtx(pool), makeMessage("ぱっちぃ 575", generatedReplies, "generation-channel")));
    assert.equal(generated, true);
    assert.deepEqual(generatedReplies, ["春風に\nコードが揺れて\nバグが咲く"]);
    assert.equal(workerRequests.length, 16);
    assert.match(workerRequests[0]!, /"rule":\[5,7,5\]/);

    const tinyCtx = makeCtx(pool);
    tinyCtx.config.PACCHI_GENERATION_MODE = "tiny-ai";
    tinyCtx.config.PACCHI_TINY_AI_URL = "http://tiny-ai:8790";
    tinyCtx.config.PACCHI_TINY_AI_TIMEOUT_MS = 100;
    const aiReplies: string[] = [];
    await withFetch(async (_input, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)), { prompt: "明日は" });
      return responseJson({ text: "明日は無理だよ" });
    }, async () => {
      assert.equal(await handlePacchiMessage(tinyCtx, makeMessage("ぱっちぃ 明日は", aiReplies, "tiny-channel")), true);
      assert.equal(await handlePacchiMessage(tinyCtx, makeMessage("ぱっちぃ 明日は", aiReplies, "tiny-channel")), false);
    });
    assert.deepEqual(aiReplies, ["明日は無理だよ"]);

    await new PostgresPacchiRepository(pool).setChannelSettings("guild", "disabled-channel", false, true);
    let disabledRequests = 0;
    await withFetch(async () => { disabledRequests++; return responseJson({ text: "unexpected" }); }, async () => {
      assert.equal(await handlePacchiMessage(tinyCtx, makeMessage("ぱっちぃ", [], "disabled-channel")), false);
    });
    assert.equal(disabledRequests, 0);

    const fallbackReplies: string[] = [];
    await withFetch(async () => responseJson({}, 503), async () => {
      assert.equal(await handlePacchiMessage(tinyCtx, makeMessage("ぱっちぃ", fallbackReplies, "fallback-channel")), true);
    });
    assert.equal(fallbackReplies.length, 1);

    // 呼びかけを含まない通常メッセージでは、tiny-ai モードでも自作AIへ問い合わせない。
    let ordinaryRequests = 0;
    const ordinaryReplies: string[] = [];
    await withFetch(async () => { ordinaryRequests++; return responseJson({ text: "unexpected" }); }, async () => {
      assert.equal(await handlePacchiMessage(tinyCtx, makeMessage("今日はいい天気だね", ordinaryReplies, "ordinary-channel")), false);
    });
    assert.equal(ordinaryRequests, 0);
    assert.deepEqual(ordinaryReplies, []);

    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const concurrentReplies: string[] = [];
    let concurrentRequests = 0;
    await withFetch(async () => {
      concurrentRequests++;
      entered!();
      await new Promise<void>((resolve) => { release = resolve; });
      return responseJson({ text: "できたよ" });
    }, async () => {
      const first = handlePacchiMessage(tinyCtx, makeMessage("ぱっちぃ", concurrentReplies, "concurrent-channel"));
      await started;
      try {
        assert.equal(await handlePacchiMessage(tinyCtx, makeMessage("ぱっちぃ", concurrentReplies, "concurrent-channel")), false);
        assert.equal(concurrentRequests, 1);
      } finally {
        release!();
        await first;
      }
    });
    assert.deepEqual(concurrentReplies, ["できたよ"]);

    // 学習の DB 書き込みが失敗しても、呼びかけへの返信は続ける。
    await pool.query(`
      CREATE FUNCTION pacchi_spec_reject_learning() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'learning rejected by spec'; END $$;
      CREATE TRIGGER pacchi_spec_reject_words BEFORE INSERT OR UPDATE ON pacchi_words
        FOR EACH ROW EXECUTE FUNCTION pacchi_spec_reject_learning();
    `);
    const learningWarnings: string[] = [];
    const learningCtx = makeCtx(pool);
    learningCtx.log.warn = ((_fields: unknown, msg: string) => { learningWarnings.push(msg); }) as never;
    const learningReplies: string[] = [];
    assert.equal(
      await handlePacchiMessage(learningCtx, makeMessage("ぱっちぃ 今日はラーメンを食べた", learningReplies, "learning-fail-channel")),
      true,
    );
    assert.equal(learningReplies.length, 1);
    assert.deepEqual(learningWarnings, ["pacchi learning failed; continuing to reply"]);
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${quotePgIdent(schemaName)} CASCADE`);
    await pool.end();
  }
}

void run()
  .then(() => console.log("pacchi.submit.spec.ts: all available assertions passed"))
  .catch((error) => { console.error(error); process.exit(1); });

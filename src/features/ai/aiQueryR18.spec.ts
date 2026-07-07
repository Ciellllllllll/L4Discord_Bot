import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ComponentType, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import type { Kysely } from "kysely";
import type { BotContext } from "../../bot/context.js";
import type { AppConfig } from "../../core/config.js";
import { createAiHistoryKysely, createKysely } from "../../core/db/kysely.js";
import type { AiHistoryDatabase, Database as AppDatabase } from "../../core/db/types.js";
import { ensureAiHistorySchema } from "./aiHistorySchema.js";
import { ensureAiR18UserSettingsSchema } from "./aiR18UserSettingsSchema.js";
import { AiQueryService } from "./aiQueryService.js";
import { handleSlashCommand } from "../../commands/slashHandlers.js";

type FetchCall = {
  url: string;
  body: { messages?: Array<{ role: string; content: string }> };
};

type InteractionRecord = {
  interaction: ChatInputCommandInteraction;
  deferred: unknown[];
  replies: unknown[];
  edits: unknown[];
};

function makeDb(): {
  sqlite: Database.Database;
  db: Kysely<AppDatabase>;
  aiHistorySqlite: Database.Database;
  aiHistoryDb: Kysely<AiHistoryDatabase>;
} {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE guild_settings (
      guild_id TEXT PRIMARY KEY NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );
  `);
  ensureAiR18UserSettingsSchema(sqlite);
  const aiHistorySqlite = new Database(":memory:");
  ensureAiHistorySchema(aiHistorySqlite);
  return {
    sqlite,
    db: createKysely(sqlite),
    aiHistorySqlite,
    aiHistoryDb: createAiHistoryKysely(aiHistorySqlite),
  };
}

function makeConfig(dir: string, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    GUILD_ID: "guild",
    BOT_PROFILE: "debug",
    BOT_VERSION: "0.0.0",
    DEEPSEEK_API_KEY: "deepseek-key",
    DEEPSEEK_API_BASE: "http://deepseek.test/v1",
    DEEPSEEK_MODEL: "deepseek-model",
    DEEPSEEK_THINKING_ENABLED: false,
    DEEPSEEK_THINKING_EFFORT: "high",
    AI_REQUEST_TIMEOUT_MS: 10_000,
    AI_MAX_RESPONSE_BYTES: 64_000,
    AI_MAX_RETRIES: 0,
    AI_TEMPERATURE: 0.7,
    AI_JUDGE_ENABLED: false,
    AI_LOG_COMMANDS_TO_HISTORY: false,
    AI_HISTORY_MAX_MESSAGES: 24,
    PROMPT_FILE_PATH: join(dir, "prompt.txt"),
    USER_PROMPT_DIR: join(dir, "user-prompts"),
    PROMPT_OPTIMIZER_ENABLED: false,
    PROMPT_OPTIMIZER_MIN_MESSAGES: 6,
    PROMPT_OPTIMIZER_INTERVAL_MESSAGES: 4,
    PROMPT_OPTIMIZER_MAX_HISTORY: 24,
    PROMPT_OPTIMIZER_TEMPERATURE: 0.2,
    R18_CHANNEL_ID: "r18-channel",
    LOCAL_LLM_API_BASE: "http://local.test/v1",
    LOCAL_LLM_API_KEY: "local-key",
    LOCAL_LLM_MODEL: "local-model",
    LOCAL_LLM_TIMEOUT_MS: 10_000,
    LOCAL_LLM_MAX_CONCURRENT: 1,
    LOCAL_LLM_MAX_QUEUE: 3,
    LOCAL_LLM_TEMPERATURE: 0.4,
    ...overrides,
  } as AppConfig;
}

function makeCtx(db: Kysely<AppDatabase>, aiHistoryDb: Kysely<AiHistoryDatabase>, config: AppConfig): BotContext {
  return {
    db,
    aiHistoryDb,
    config,
    client: { users: { cache: new Map() } },
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  } as unknown as BotContext;
}

function makeInteraction(input: {
  userId: string;
  channelId: string;
  text?: string;
  onDefer?: () => void | Promise<void>;
}): InteractionRecord {
  const deferred: unknown[] = [];
  const replies: unknown[] = [];
  const edits: unknown[] = [];
  const interaction = {
    commandName: "q",
    guildId: "guild",
    channelId: input.channelId,
    channel: { id: input.channelId },
    guild: { id: "guild" },
    member: null,
    user: { id: input.userId, username: `name-${input.userId}` },
    inGuild: () => true,
    options: {
      getString: (name: string, required?: boolean) => {
        assert.equal(name, "text");
        assert.equal(required, true);
        return input.text ?? "質問です";
      },
    },
    deferReply: async (payload?: unknown) => {
      deferred.push(payload);
      await input.onDefer?.();
    },
    reply: async (payload: unknown) => {
      replies.push(payload);
    },
    editReply: async (payload: unknown) => {
      edits.push(payload);
      return {};
    },
  } as unknown as ChatInputCommandInteraction;
  return { interaction, deferred, replies, edits };
}

function makeMonitorMessage(input: {
  userId: string;
  text?: string;
  replies?: unknown[];
}) {
  const replies = input.replies ?? [];
  return {
    guild: { id: "guild" },
    guildId: "guild",
    author: { id: input.userId, username: `name-${input.userId}`, bot: false },
    member: null,
    channel: {},
    content: input.text ?? "monitor question",
    reply: async (payload: unknown) => {
      replies.push(payload);
      return {};
    },
  } as unknown as import("discord.js").Message;
}

async function setR18(db: Kysely<AppDatabase>, userId: string, enabled: boolean): Promise<void> {
  await db
    .insertInto("ai_r18_user_settings")
    .values({
      guild_id: "guild",
      user_id: userId,
      enabled: enabled ? 1 : 0,
      updated_at: "2026-01-01T00:00:00.000Z",
    })
    .onConflict((oc) =>
      oc.columns(["guild_id", "user_id"]).doUpdateSet({
        enabled: enabled ? 1 : 0,
        updated_at: "2026-01-01T00:00:00.000Z",
      }),
    )
    .execute();
}

async function historyRows(aiHistoryDb: Kysely<AiHistoryDatabase>) {
  return aiHistoryDb.selectFrom("ai_history").selectAll().orderBy("role", "asc").execute();
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function run(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "l4-ai-r18-"));
  writeFileSync(join(dir, "prompt.txt"), "Base prompt", "utf8");
  const { sqlite, db, aiHistorySqlite, aiHistoryDb } = makeDb();
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];

  const standardFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as FetchCall["body"];
    calls.push({ url: input.toString(), body });
    const isLocal = input.toString().startsWith("http://local.test");
    return Response.json({
      choices: [{ message: { content: isLocal ? "local answer" : "deepseek answer" } }],
    });
  }) as typeof fetch;
  globalThis.fetch = standardFetch;

  try {
    {
      const config = makeConfig(dir);
      const ctx = makeCtx(db, aiHistoryDb, config);
      const rec = makeInteraction({ userId: "off-user", channelId: "normal-channel" });
      await handleSlashCommand(rec.interaction, ctx);

      assert.equal(calls.at(-1)?.url, "http://deepseek.test/v1/chat/completions");
      const rows = await historyRows(aiHistoryDb);
      assert.equal(rows.length, 2);
      assert.deepEqual(JSON.parse(String(rows[0]?.meta)), { provider: "deepseek", r18: false });
      const payload = rec.edits[0] as { components?: Array<{ type: ComponentType; components?: Array<{ type: ComponentType; content?: string }> }> };
      assert.equal(payload.components?.length, 1);
      const container = payload.components?.[0];
      assert.equal(container?.type, ComponentType.Container);
      const texts = container?.components
        ?.filter((component) => component.type === ComponentType.TextDisplay)
        .map((component) => component.content ?? "") ?? [];
      assert.deepEqual(texts.slice(0, 2), ["### 質問\n質問です", "### 回答\ndeepseek answer"]);
      assert.equal(/^## 回答$/m.test(texts.join("\n")), false);
    }

    {
      calls.length = 0;
      const longAnswer = `long answer ${"x".repeat(4100)}`;
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as FetchCall["body"];
        calls.push({ url: input.toString(), body });
        return Response.json({ choices: [{ message: { content: longAnswer } }] });
      }) as typeof fetch;
      const config = makeConfig(dir);
      const ctx = makeCtx(db, aiHistoryDb, config);
      const rec = makeInteraction({ userId: "long-answer-user", channelId: "normal-channel" });
      await handleSlashCommand(rec.interaction, ctx);

      const payload = rec.edits[0] as { components?: Array<{ type: ComponentType; components?: Array<{ type: ComponentType; content?: string }> }> };
      const container = payload.components?.[0];
      assert.equal(container?.type, ComponentType.Container);
      const children = container?.components ?? [];
      assert.match(children.find((component) => component.type === ComponentType.TextDisplay)?.content ?? "", /### 質問/);
      assert.match(children.filter((component) => component.type === ComponentType.TextDisplay).at(-1)?.content ?? "", /一部のみ表示/);
      assert.equal(children.at(-1)?.type, ComponentType.ActionRow);
      globalThis.fetch = standardFetch;
    }

    {
      calls.length = 0;
      const config = makeConfig(dir);
      const ctx = makeCtx(db, aiHistoryDb, config);
      const rec = makeInteraction({
        userId: "race-user",
        channelId: "normal-channel",
        onDefer: async () => {
          await setR18(db, "race-user", true);
        },
      });
      await handleSlashCommand(rec.interaction, ctx);

      assert.equal(rec.deferred[0], undefined);
      assert.equal(calls.at(-1)?.url, "http://deepseek.test/v1/chat/completions");
      const rows = (await historyRows(aiHistoryDb)).filter((row) => row.user_id === "race-user");
      assert.equal(rows.length, 2);
      assert.deepEqual(JSON.parse(String(rows[0]?.meta)), { provider: "deepseek", r18: false });
    }

    {
      calls.length = 0;
      await setR18(db, "blocked-user", true);
      const config = makeConfig(dir);
      const ctx = makeCtx(db, aiHistoryDb, config);
      const rec = makeInteraction({ userId: "blocked-user", channelId: "normal-channel" });
      const before = (await historyRows(aiHistoryDb)).length;
      await new AiQueryService(ctx).routeSlashInteraction(rec.interaction);

      assert.equal(calls.length, 0);
      assert.equal((await historyRows(aiHistoryDb)).length, before);
      assert.match(String((rec.edits[0] as { content?: string })?.content), /R18|チャンネル/);
    }

    {
      calls.length = 0;
      await setR18(db, "local-user", true);
      const config = makeConfig(dir, { AI_JUDGE_ENABLED: true });
      const ctx = makeCtx(db, aiHistoryDb, config);
      const rec = makeInteraction({ userId: "local-user", channelId: "r18-channel" });
      await handleSlashCommand(rec.interaction, ctx);

      assert.deepEqual(rec.deferred[0], { flags: MessageFlags.Ephemeral });
      assert.equal(calls.at(-1)?.url, "http://local.test/v1/chat/completions");
      assert.equal(calls.some((call) => call.url.startsWith("http://deepseek.test")), false);
      assert.ok(calls.at(-1)?.body.messages?.some((m) => m.role === "system" && /未成年|非同意|実在人物/.test(m.content)));
      const systemMessages = calls.at(-1)?.body.messages?.filter((m) => m.role === "system") ?? [];
      assert.match(systemMessages.at(-1)?.content ?? "", /未成年|非同意|実在人物/);
      const rows = (await historyRows(aiHistoryDb)).filter((row) => row.user_id === "local-user");
      assert.equal(rows.length, 2);
      assert.deepEqual(JSON.parse(String(rows[0]?.meta)), { provider: "local_llm", r18: true });
    }

    {
      calls.length = 0;
      await setR18(db, "history-user", true);
      const r18Config = makeConfig(dir);
      const r18Ctx = makeCtx(db, aiHistoryDb, r18Config);
      const r18Rec = makeInteraction({ userId: "history-user", channelId: "r18-channel", text: "R18 secret history" });
      await new AiQueryService(r18Ctx).routeSlashInteraction(r18Rec.interaction);

      await setR18(db, "history-user", false);
      calls.length = 0;
      const normalConfig = makeConfig(dir);
      const normalCtx = makeCtx(db, aiHistoryDb, normalConfig);
      const normalRec = makeInteraction({ userId: "history-user", channelId: "normal-channel", text: "normal question" });
      await new AiQueryService(normalCtx).routeSlashInteraction(normalRec.interaction);

      const deepseekMessages = calls.find((call) => call.url.startsWith("http://deepseek.test"))?.body.messages ?? [];
      assert.equal(deepseekMessages.some((m) => m.content.includes("R18 secret history")), false);
      assert.equal(deepseekMessages.some((m) => m.content.includes("local answer")), false);
    }

    {
      calls.length = 0;
      await setR18(db, "normal-history-user", false);
      const config = makeConfig(dir);
      const ctx = makeCtx(db, aiHistoryDb, config);
      const first = makeInteraction({ userId: "normal-history-user", channelId: "normal-channel", text: "first normal" });
      await new AiQueryService(ctx).routeSlashInteraction(first.interaction);
      calls.length = 0;
      const second = makeInteraction({ userId: "normal-history-user", channelId: "normal-channel", text: "second normal" });
      await new AiQueryService(ctx).routeSlashInteraction(second.interaction);

      const messages = calls.at(-1)?.body.messages ?? [];
      const systemMessages = messages.filter((m) => m.role === "system");
      assert.equal(systemMessages.filter((m) => m.content.includes("Current active user prompt follows")).length, 2);
      assert.equal(messages.at(-1)?.content, "second normal");
    }

    {
      calls.length = 0;
      await setR18(db, "r18-order-user", true);
      const config = makeConfig(dir);
      const ctx = makeCtx(db, aiHistoryDb, config);
      const first = makeInteraction({ userId: "r18-order-user", channelId: "r18-channel", text: "first r18" });
      await new AiQueryService(ctx).routeSlashInteraction(first.interaction);
      calls.length = 0;
      const second = makeInteraction({ userId: "r18-order-user", channelId: "r18-channel", text: "second r18" });
      await new AiQueryService(ctx).routeSlashInteraction(second.interaction);

      const messages = calls.at(-1)?.body.messages ?? [];
      const systemMessages = messages.filter((m) => m.role === "system");
      assert.equal(systemMessages.filter((m) => m.content.includes("Current active user prompt follows")).length, 2);
      assert.match(systemMessages.at(-1)?.content ?? "", /未成年|非同意|実在人物/);
      assert.equal(messages.at(-1)?.content, "second r18");
    }

    {
      calls.length = 0;
      await setR18(db, "monitor-r18-user", true);
      const config = makeConfig(dir, { AI_JUDGE_ENABLED: true });
      const ctx = makeCtx(db, aiHistoryDb, config);
      const replies: unknown[] = [];
      const message = makeMonitorMessage({ userId: "monitor-r18-user", text: "do not send to deepseek", replies });
      await new AiQueryService(ctx).routeMonitorMessage(message, "do not send to deepseek");

      assert.equal(calls.length, 0);
      assert.match(String((replies[0] as { content?: string })?.content), /R18|\/q|チャンネル/);
    }

    {
      calls.length = 0;
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as FetchCall["body"];
        calls.push({ url: input.toString(), body });
        if (input.toString().startsWith("http://local.test")) {
          return new Response("local failure", { status: 500 });
        }
        return Response.json({ choices: [{ message: { content: "deepseek answer" } }] });
      }) as typeof fetch;

      await setR18(db, "local-fail-user", true);
      const config = makeConfig(dir);
      const ctx = makeCtx(db, aiHistoryDb, config);
      const rec = makeInteraction({ userId: "local-fail-user", channelId: "r18-channel" });
      const before = (await historyRows(aiHistoryDb)).length;
      await handleSlashCommand(rec.interaction, ctx);

      assert.equal(calls.at(-1)?.url, "http://local.test/v1/chat/completions");
      assert.equal((await historyRows(aiHistoryDb)).length, before);
      assert.equal((rec.edits.at(-1) as { content?: string })?.content, "AI への問い合わせに失敗しました。しばらくしてから再度お試しください。");
    }

    {
      calls.length = 0;
      const hold = deferred<void>();
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as FetchCall["body"];
        calls.push({ url: input.toString(), body });
        if (input.toString().startsWith("http://local.test")) {
          await hold.promise;
          return Response.json({ choices: [{ message: { content: "released wait" } }] });
        }
        return Response.json({ choices: [{ message: { content: "deepseek answer" } }] });
      }) as typeof fetch;

      await setR18(db, "queue-running", true);
      await setR18(db, "queue-rejected", true);
      const config = makeConfig(dir, { LOCAL_LLM_MAX_QUEUE: 0 });
      const ctx = makeCtx(db, aiHistoryDb, config);
      const first = makeInteraction({ userId: "queue-running", channelId: "r18-channel" });
      const firstPromise = new AiQueryService(ctx).routeSlashInteraction(first.interaction);
      await Promise.resolve();
      const before = (await historyRows(aiHistoryDb)).length;
      const rejected = makeInteraction({ userId: "queue-rejected", channelId: "r18-channel" });
      await new AiQueryService(ctx).routeSlashInteraction(rejected.interaction);

      assert.equal(calls.filter((call) => call.url.startsWith("http://local.test")).length, 1);
      assert.equal((await historyRows(aiHistoryDb)).length, before);
      assert.match(String((rejected.edits[0] as { content?: string })?.content), /混雑|待機/);
      hold.resolve();
      await firstPromise;
    }

    {
      calls.length = 0;
      const hold = deferred<void>();
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as FetchCall["body"];
        calls.push({ url: input.toString(), body });
        if (input.toString().startsWith("http://local.test")) {
          await hold.promise;
          return Response.json({ choices: [{ message: { content: "released wait" } }] });
        }
        return Response.json({ choices: [{ message: { content: "deepseek answer" } }] });
      }) as typeof fetch;

      await setR18(db, "wait-running", true);
      await setR18(db, "wait-queued", true);
      const config = makeConfig(dir, { LOCAL_LLM_MAX_QUEUE: 1 });
      const ctx = makeCtx(db, aiHistoryDb, config);
      const first = makeInteraction({ userId: "wait-running", channelId: "r18-channel" });
      const firstPromise = new AiQueryService(ctx).routeSlashInteraction(first.interaction);
      await waitFor(() => calls.filter((call) => call.url.startsWith("http://local.test")).length === 1);
      const queued = makeInteraction({ userId: "wait-queued", channelId: "r18-channel" });
      const queuedPromise = new AiQueryService(ctx).routeSlashInteraction(queued.interaction);
      await waitFor(() => queued.edits.length > 0);

      assert.match(String((queued.edits[0] as { content?: string })?.content), /待機中: あなたの前に1件あります/);
      hold.resolve();
      await firstPromise;
      await queuedPromise;
    }

    {
      calls.length = 0;
      const hold = deferred<Response>();
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as FetchCall["body"];
        calls.push({ url: input.toString(), body });
        return await hold.promise;
      }) as typeof fetch;

      await setR18(db, "duplicate-user", true);
      const config = makeConfig(dir, { LOCAL_LLM_MAX_QUEUE: 1 });
      const ctx = makeCtx(db, aiHistoryDb, config);
      const first = makeInteraction({ userId: "duplicate-user", channelId: "r18-channel" });
      const firstPromise = new AiQueryService(ctx).routeSlashInteraction(first.interaction);
      await Promise.resolve();
      const before = (await historyRows(aiHistoryDb)).length;
      const duplicate = makeInteraction({ userId: "duplicate-user", channelId: "r18-channel" });
      await new AiQueryService(ctx).routeSlashInteraction(duplicate.interaction);

      assert.equal(calls.filter((call) => call.url.startsWith("http://local.test")).length, 1);
      assert.equal((await historyRows(aiHistoryDb)).length, before);
      assert.match(String((duplicate.edits[0] as { content?: string })?.content), /処理中/);
      hold.resolve(Response.json({ choices: [{ message: { content: "released duplicate" } }] }));
      await firstPromise;
    }
  } finally {
    globalThis.fetch = originalFetch;
    await db.destroy();
    await aiHistoryDb.destroy();
    sqlite.close();
    aiHistorySqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

void run()
  .then(() => {
    console.log("aiQueryR18.spec.ts: all assertions passed");
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

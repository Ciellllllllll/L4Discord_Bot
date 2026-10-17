import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ComponentType, MessageFlags, type Message, type MessageCreateOptions, type MessageEditOptions } from "discord.js";
import type { BotContext } from "../../../bot/context.js";
import { LinkExpansionRepository, type ExpansionRecord, type ExpansionSource } from "./linkExpansionRepository.js";
import { LinkExpansionTracker } from "./linkExpansionTracker.js";

class MemoryRepository extends LinkExpansionRepository {
  readonly sources = new Map<string, ExpansionSource>();
  readonly responses = new Map<string, ExpansionRecord>();
  failSave = false;
  constructor() { super({} as never, () => "bot"); }
  override async source(id: string) {
    const row = this.sources.get(id);
    return row && row.expires_at.getTime() > Date.now() ? row : undefined;
  }
  override async register(message: Message) {
    if (!this.sources.has(message.id)) this.sources.set(message.id, {
      bot_id: "bot", message_id: message.id, channel_id: message.channelId, guild_id: message.guildId!,
      content_hash: null, expires_at: new Date(Date.now() + 7 * 86_400_000),
    });
    return this.source(message.id);
  }
  override async records(id: string) { return [...this.responses.values()].filter((row) => row.source_message_id === id); }
  override async save(record: ExpansionRecord) {
    if (this.failSave) throw new Error("database unavailable");
    for (const row of await this.records(record.source_message_id)) {
      if (row.expansion_key === record.expansion_key) this.responses.delete(row.response_message_id);
    }
    this.responses.set(record.response_message_id, record);
  }
  override async wouldCycle(responseId: string, quotedId: string) {
    const seen = new Set<string>();
    let id: string | null = quotedId;
    while (id && !seen.has(id)) {
      if (id === responseId) return true;
      seen.add(id);
      id = this.responses.get(id)?.quoted_message_id ?? null;
    }
    return false;
  }
  override async markRendered(id: string, hash: string) { this.sources.get(id)!.content_hash = hash; }
  override async forgetResponse(id: string) { this.responses.delete(id); }
  override async forgetSource(id: string) {
    this.sources.delete(id);
    for (const row of await this.records(id)) this.responses.delete(row.response_message_id);
  }
  override async affected(id: string, includeResponses = false) {
    const ids = new Set([...this.responses.values()].filter((row) => row.quoted_message_id === id || (includeResponses && row.response_message_id === id))
      .map((row) => row.source_message_id));
    ids.add(id);
    return [...this.sources.values()].filter((row) => ids.has(row.message_id) && row.expires_at.getTime() > Date.now());
  }
  override async page(after = "") { return [...this.sources.values()].filter((row) => row.message_id > after && row.expires_at.getTime() > Date.now()); }
  override async cleanup() {
    for (const [id, row] of this.sources) if (row.expires_at.getTime() <= Date.now()) await this.forgetSource(id);
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const repository = new MemoryRepository();
  const messages = new Map<string, Message>();
  const edits: Array<{ id: string; payload: MessageEditOptions }> = [];
  const deleted: string[] = [];
  const warnings: unknown[] = [];
  const fetchErrors = new Map<string, number>();
  let count = 0;
  let renders = 0;
  let gate: ReturnType<typeof deferred> | undefined;
  let overridePayload: MessageCreateOptions | undefined;
  let lookupFailure = false;
  let retryReplies = false;
  const entered = deferred();
  const channel = {
    isTextBased: () => true, isDMBased: () => false,
    messages: { fetch: async (input: string | { message: string }) => {
      const id = typeof input === "string" ? input : input.message;
      const message = messages.get(id);
      if (fetchErrors.has(id) || !message) throw Object.assign(new Error("fetch error"), { code: fetchErrors.get(id) ?? 10008 });
      return message;
    } },
    send: async (payload: MessageCreateOptions) => makeMessage(`response-${++count}`, payload),
  };
  function makeMessage(id: string, payload: MessageCreateOptions = {}): Message {
    let flag = Number(payload.flags ?? 0);
    const message = {
      id, guildId: "other-guild", channelId: "channel", content: payload.content ?? "",
      author: { id: "reader", bot: false }, embeds: [], components: payload.components ?? [], attachments: new Map(),
      channel, flags: { has: (value: number) => Boolean(flag & value) },
      reply: channel.send,
      delete: async () => { deleted.push(id); messages.delete(id); },
      edit: async (update: MessageEditOptions) => {
        edits.push({ id, payload: update });
        Object.assign(message, { content: update.content ?? "", components: update.components ?? [] });
        flag = Number(update.flags ?? flag);
        return message;
      },
    } as unknown as Message;
    messages.set(id, message);
    return message;
  }
  const ctx = { client: { channels: { fetch: async () => channel } }, log: { warn: (entry: unknown) => warnings.push(entry) } } as unknown as BotContext;
  const quote = makeMessage("quote", { content: "引用本文" });
  const source = makeMessage("source", { content: "https://example.com/one https://example.com/two" });
  const render = async (message: Message) => {
    renders++;
    entered.resolve();
    if (gate) await gate.promise;
    if (lookupFailure) throw new Error("temporary lookup failure before reply");
    const urls = message.content.match(/https:\/\/\S+/g) ?? [];
    for (const [index, url] of urls.entries()) {
      const quoteId = url.includes("/self") ? "response-1" : "quote";
      const quoted = url.includes("discord.com") ? messages.get(quoteId) : undefined;
      if (url.includes("discord.com") && !quoted) continue;
      const sent = tracker.reply(message, `${quoted ? "discord" : "web"}:${index}`, overridePayload ?? {
        components: [{ type: ComponentType.TextDisplay, content: quoted?.content ?? url }],
        flags: MessageFlags.IsComponentsV2,
      }, quoted, { retry: retryReplies });
      if (url.includes("/self")) await sent.catch(() => undefined);
      else await sent;
    }
  };
  let tracker = new LinkExpansionTracker(ctx, repository, render);
  return {
    source, quote, repository, messages, edits, deleted, warnings, fetchErrors, entered,
    get tracker() { return tracker; },
    restart() { tracker = new LinkExpansionTracker(ctx, repository, render); },
    block() { gate = deferred(); return gate; },
    payload(value: MessageCreateOptions) { overridePayload = value; },
    failLookup(value: boolean) { lookupFailure = value; },
    retryReplies(value: boolean) { retryReplies = value; },
    renders: () => renders, sent: () => count,
  };
}

void test("initial lookup failures leave a retryable source without saving its content hash", async () => {
  const f = fixture();
  f.failLookup(true);
  await assert.rejects(f.tracker.onCreate(f.source), /temporary lookup/);
  assert.equal(f.repository.sources.size, 1);
  assert.equal(f.repository.sources.get("source")?.content_hash, null);
  assert.equal(f.sent(), 0);
  f.failLookup(false);
  await f.tracker.reconcile();
  assert.equal(f.repository.responses.size, 2);
});

void test("lookup failures preserve existing cards and retry the changed source on reconciliation", async () => {
  const f = fixture();
  await f.tracker.onCreate(f.source);
  const hash = f.repository.sources.get("source")!.content_hash;
  f.source.content = "https://example.com/edited";
  f.failLookup(true);
  await assert.rejects(f.tracker.onUpdate(f.source), /temporary lookup/);
  assert.equal(f.repository.sources.get("source")!.content_hash, hash);
  assert.deepEqual(f.deleted, []);
  assert.equal(f.repository.responses.size, 2);
  f.failLookup(false);
  await f.tracker.reconcile();
  assert.equal(f.edits[0]?.id, "response-1");
  assert.deepEqual(f.deleted, ["response-2"]);
});

void test("retryable fallback replies keep the source unrendered until reconciliation restores the preview", async () => {
  const f = fixture();
  await f.tracker.onCreate(f.source);
  const rendered = f.repository.sources.get("source")!.content_hash;
  f.source.content = "https://example.com/edited https://example.com/two";
  f.retryReplies(true);
  await f.tracker.onUpdate(f.source);
  assert.equal(f.edits.length, 2, "the fallback still replaces the stale cards");
  assert.equal(f.repository.sources.get("source")!.content_hash, rendered, "the new content is not marked as rendered");
  assert.equal(f.repository.responses.size, 2);
  f.retryReplies(false);
  await f.tracker.reconcile();
  assert.equal(f.edits.length, 4, "reconciliation rebuilds the cards after the upstream recovers");
  assert.equal(f.repository.sources.get("source")!.content_hash, createHash("sha256").update(f.source.content).digest("hex"));
  await f.tracker.reconcile();
  assert.equal(f.edits.length, 4, "a completed render is not rebuilt again");
});

void test("updates registered responses in place and deletes removed links without extending expiry", async () => {
  const f = fixture();
  await f.tracker.onCreate(f.source);
  const expires = f.repository.sources.get("source")!.expires_at.getTime();
  f.source.content = "https://example.com/changed";
  await f.tracker.onUpdate(f.source);
  assert.equal(f.sent(), 2);
  assert.equal(f.edits[0]?.id, "response-1");
  assert.deepEqual(f.deleted, ["response-2"]);
  assert.equal(f.repository.sources.get("source")!.expires_at.getTime(), expires);
  f.source.content = "リンクを取り消しました";
  await f.tracker.onUpdate(f.source);
  assert.equal(f.repository.responses.size, 0);
  assert.equal(f.repository.sources.size, 1, "remember the original expiry even with no remaining links");
  f.source.content = "https://example.com/again";
  await f.tracker.onUpdate(f.source);
  assert.equal(f.sent(), 3);
  assert.equal(f.repository.sources.get("source")!.expires_at.getTime(), expires);
});

void test("source deletion removes all registered responses even without cached content", async () => {
  const f = fixture();
  await f.tracker.onCreate(f.source);
  f.messages.delete(f.source.id);
  await f.tracker.onDelete({ id: f.source.id });
  assert.deepEqual(f.deleted, ["response-1", "response-2"]);
  assert.equal(f.repository.sources.size, 0);
});

void test("quoted message edits update existing cards and deletion removes only affected cards", async () => {
  const f = fixture();
  f.source.content = "https://discord.com/channels/1/2/3 https://example.com/other";
  await f.tracker.onCreate(f.source);
  f.quote.content = "編集された引用本文";
  await f.tracker.onUpdate(f.quote);
  assert.equal(f.sent(), 2);
  assert.equal(JSON.stringify(f.edits[0]?.payload).includes("編集された引用本文"), true);
  f.messages.delete("quote");
  await f.tracker.onDelete({ id: "quote" });
  assert.deepEqual(f.deleted, ["response-1"]);
  assert.equal(f.repository.responses.size, 1);
});

void test("bot response updates do not trigger rendering loops", async () => {
  const f = fixture();
  await f.tracker.onCreate(f.source);
  await f.tracker.onUpdate({ id: "response-1" });
  await f.tracker.onUpdate(f.source);
  assert.equal(f.renders(), 1);
});

void test("restart reconciles offline source edits, source deletions and quoted deletions", async () => {
  for (const change of ["edit", "delete", "quote-delete", "quote-edit"] as const) {
    const f = fixture();
    f.source.content = "https://discord.com/channels/1/2/3";
    await f.tracker.onCreate(f.source);
    f.restart();
    if (change === "edit") f.source.content = "https://example.com/new";
    if (change === "delete") f.messages.delete("source");
    if (change === "quote-delete") f.messages.delete("quote");
    if (change === "quote-edit") f.quote.content = "停止中の編集";
    await f.tracker.reconcile();
    if (change.endsWith("delete")) assert.deepEqual(f.deleted, ["response-1"]);
    else if (change === "quote-edit") assert.ok(JSON.stringify(f.edits).includes("停止中の編集"));
    else assert.ok(f.messages.get("response-2"), "new link category gets its own response");
  }
});

void test("expiry removes only database associations and ignores later updates or deletions", async () => {
  const f = fixture();
  await f.tracker.onCreate(f.source);
  f.repository.sources.get("source")!.expires_at = new Date(Date.now() - 1);
  f.source.content = "https://example.com/changed";
  await f.tracker.onUpdate(f.source);
  await f.tracker.onDelete(f.source);
  await f.tracker.reconcile();
  assert.equal(f.edits.length, 0);
  assert.deepEqual(f.deleted, []);
  assert.equal(f.repository.sources.size, 0);
});

void test("temporary permission or API failures keep associations for reconciliation retry", async () => {
  for (const code of [50001, 50013, 503]) {
    const f = fixture();
    await f.tracker.onCreate(f.source);
    f.fetchErrors.set("source", code);
    await f.tracker.reconcile();
    assert.equal(f.repository.responses.size, 2);
    assert.deepEqual(f.deleted, []);
    assert.equal(f.warnings.length, 1);
  }
});

void test("deletion during a queued render prevents a late response", async () => {
  const f = fixture();
  const gate = f.block();
  const create = f.tracker.onCreate(f.source);
  await f.entered.promise;
  f.messages.delete("source");
  const deletion = f.tracker.onDelete({ id: "source" });
  gate.resolve();
  await assert.rejects(create, /deleted|fetch error/);
  await deletion;
  assert.equal(f.sent(), 0);
  assert.equal(f.repository.sources.size, 0);
});

void test("edit during a queued render prevents stale output and processes the latest source", async () => {
  const f = fixture();
  const gate = f.block();
  const create = f.tracker.onCreate(f.source);
  await f.entered.promise;
  // Discord update objects are different from the snapshot used by an in-flight renderer.
  const updated = { ...f.source, content: "https://example.com/latest" } as Message;
  f.messages.set("source", updated);
  const update = f.tracker.onUpdate(updated);
  gate.resolve();
  await assert.rejects(create, /changed/);
  await update;
  assert.equal(f.sent(), 1);
  assert.ok(JSON.stringify(f.messages.get("response-1")?.components).includes("latest"));
});

void test("a failed persistence write removes the newly sent untracked response", async () => {
  const f = fixture();
  f.repository.failSave = true;
  await assert.rejects(f.tracker.onCreate(f.source), /database unavailable/);
  assert.deepEqual(f.deleted, ["response-1"]);
  assert.equal(f.repository.responses.size, 0);
  f.repository.failSave = false;
  await f.tracker.reconcile();
  assert.equal(f.repository.responses.size, 2);
});

void test("deleting a response manually removes its association without deleting sibling responses", async () => {
  const f = fixture();
  await f.tracker.onCreate(f.source);
  f.messages.delete("response-1");
  await f.tracker.onDelete({ id: "response-1" });
  assert.equal(f.repository.responses.size, 1);
  assert.deepEqual(f.deleted, []);
});

void test("unexpanded messages and bot-authored links are never registered", async () => {
  const f = fixture();
  f.source.content = "通常の会話";
  await f.tracker.onCreate(f.source);
  assert.equal(f.repository.sources.size, 0);
  f.source.content = "https://example.com/";
  f.source.author.bot = true;
  await f.tracker.onCreate(f.source);
  assert.equal(f.repository.sources.size, 0);
});

void test("a text-only provider fallback edits an existing V2 response and clears previous attachments", async () => {
  const f = fixture();
  await f.tracker.onCreate(f.source);
  f.source.content = "https://example.com/new";
  f.payload({ content: "<https://example.com/fallback>", flags: MessageFlags.SuppressEmbeds });
  await f.tracker.onUpdate(f.source);
  assert.equal(f.edits[0]?.id, "response-1");
  assert.equal(f.edits[0]?.payload.content, null);
  assert.equal(f.edits[0]?.payload.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(f.edits[0]?.payload.attachments, []);
  assert.ok(JSON.stringify(f.edits[0]?.payload.components).includes("fallback"));
  assert.equal(f.sent(), 2);
});

void test("an edited response is removed if saving its new source mapping fails", async () => {
  const f = fixture();
  await f.tracker.onCreate(f.source);
  f.source.content = "https://example.com/new";
  f.repository.failSave = true;
  await assert.rejects(f.tracker.onUpdate(f.source), /database unavailable/);
  assert.deepEqual(f.deleted, ["response-1"]);
  f.repository.failSave = false;
  await f.tracker.reconcile();
  assert.equal(f.repository.responses.size, 1);
  assert.equal(f.sent(), 3);
});

void test("shutdown drains queued renders without sending further responses", async () => {
  const f = fixture();
  const gate = f.block();
  const create = f.tracker.onCreate(f.source);
  await f.entered.promise;
  const stopped = f.tracker.stop();
  gate.resolve();
  await assert.rejects(create, /deleted/);
  await stopped;
  await f.tracker.onCreate(f.source);
  await f.tracker.onUpdate(f.source);
  await f.tracker.reconcile();
  assert.equal(f.sent(), 0);
});

void test("self-referential quotes are removed instead of repeatedly editing their own response", async () => {
  const f = fixture();
  f.source.content = "https://discord.com/channels/1/2/quote";
  await f.tracker.onCreate(f.source);
  f.source.content = "https://discord.com/channels/1/2/self";
  await f.tracker.onUpdate(f.source);
  assert.deepEqual(f.deleted, ["response-1"]);
  assert.equal(f.edits.length, 0);
  assert.equal(f.repository.responses.size, 0);
  await f.tracker.onUpdate({ id: "response-1" });
  assert.equal(f.renders(), 2);
});

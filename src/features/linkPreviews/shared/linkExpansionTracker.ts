import { createHash } from "node:crypto";
import { ComponentType, MessageFlags, type Message, type MessageCreateOptions } from "discord.js";
import type { BotContext } from "../../../bot/context.js";
import { LinkExpansionRepository, type ExpansionRecord, type ExpansionSource } from "./linkExpansionRepository.js";

/** retry: 一時的な失敗による代替表示。送信後も未完了として扱い、定期確認で再構築する。 */
export type ExpansionReplyOptions = { retry?: boolean };

export type ExpansionReply = (
  message: Message, key: string, payload: MessageCreateOptions, quoted?: Message, options?: ExpansionReplyOptions,
) => Promise<Message>;

/** 追跡期間。DB の既定値（7日）と揃える。 */
const EXPANSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function sourceHash(message: Pick<Message, "content">): string {
  return createHash("sha256").update(message.content ?? "").digest("hex");
}

function quotedHash(message: Message): string {
  return createHash("sha256").update(JSON.stringify([
    message.content, message.embeds, message.components, [...message.attachments.values()],
  ])).digest("hex");
}

function missingMessage(error: unknown): boolean {
  return [10008, 10003].includes(Number((error as { code?: unknown })?.code));
}

type RenderSession = {
  source?: ExpansionSource;
  hash: string;
  records: ExpansionRecord[];
  seen: Set<string>;
  deleted: Set<string>;
  references: Set<string>;
  failures: Set<string>;
};

export class CyclicQuoteError extends Error {}

export class LinkExpansionTracker {
  // shortcut: 更新の直列化は1プロセス内。同一BOTの複数稼働に対応する場合はDBロックへ移す。
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly sessions = new Map<string, RenderSession>();
  private reconciling = false;
  private stopped = false;

  constructor(
    private readonly ctx: Pick<BotContext, "client" | "log">,
    private readonly repository: LinkExpansionRepository,
    private readonly render: (message: Message) => Promise<void>,
  ) {}

  private async serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(id);
    const current = (async () => { await previous?.catch(() => undefined); return operation(); })();
    this.pending.set(id, current);
    try { return await current; }
    finally { if (this.pending.get(id) === current) this.pending.delete(id); }
  }

  private async fetchMessage(channelId: string, messageId: string): Promise<Message> {
    const channel = await this.ctx.client.channels.fetch(channelId);
    if (!channel?.isTextBased() || channel.isDMBased()) throw new Error("Expansion channel is unavailable");
    return channel.messages.fetch({ message: messageId, force: true });
  }

  private async remove(record: ExpansionRecord, channelId: string): Promise<void> {
    try {
      const response = await this.fetchMessage(channelId, record.response_message_id);
      await response.delete();
    } catch (error) { if (!missingMessage(error)) throw error; }
    await this.repository.forgetResponse(record.response_message_id);
  }

  private async removeSource(source: ExpansionSource): Promise<void> {
    for (const record of await this.repository.records(source.message_id)) await this.remove(record, source.channel_id);
    await this.repository.forgetSource(source.message_id);
  }

  readonly reply: ExpansionReply = (message, key, payload, quoted, options) => quoted
    ? this.serial("quoted-replies", () => this.sendReply(message, key, payload, quoted, options))
    : this.sendReply(message, key, payload, undefined, options);

  /** 送信はせず未完了として扱う。失敗カードを出さない投稿も、定期確認で再試行できるようにする。 */
  readonly defer = async (message: Message, key: string): Promise<void> => {
    const session = this.sessions.get(message.id);
    if (!session) throw new Error("Expansion defer outside render session");
    session.failures.add(key);
    session.source ??= await this.repository.register(message);
  };

  private async sendReply(
    message: Message, key: string, payload: MessageCreateOptions, quoted?: Message, options?: ExpansionReplyOptions,
  ): Promise<Message> {
    const session = this.sessions.get(message.id);
    if (!session) throw new Error("Expansion reply outside render session");
    session.seen.add(key);
    if (quoted) session.references.add(quoted.id);
    let written: Message | undefined;
    try {
      if (this.stopped || session.deleted.has(message.id) || (quoted && session.deleted.has(quoted.id))) {
        throw new Error("Expansion source was deleted");
      }
      if (!session.source) {
        const source = await this.repository.register(message);
        if (!source) throw new Error("Expansion tracking expired");
        session.source = source;
      }
      if (new Date(session.source.expires_at).getTime() <= Date.now()) throw new Error("Expansion tracking expired");
      // キュー待ちの間に削除・編集された投稿の古いカードを送らない。
      const latest = await this.fetchMessage(message.channelId, message.id);
      if (sourceHash(latest) !== session.hash) throw new Error("Expansion source changed during rendering");
      if (quoted) {
        const latestQuote = await this.fetchMessage(quoted.channelId, quoted.id);
        if (quotedHash(latestQuote) !== quotedHash(quoted)) throw new Error("Quoted message changed during rendering");
      }
      const existing = session.records.find((record) => record.expansion_key === key);
      // 展開先自身や循環する引用を編集すると、更新イベントが互いを再生成してしまう。
      if (quoted && existing && await this.repository.wouldCycle(existing.response_message_id, quoted.id)) {
        throw new CyclicQuoteError("Cyclic message quote ignored");
      }
      let response: Message | undefined;
      if (existing) {
        try { response = await this.fetchMessage(message.channelId, existing.response_message_id); }
        catch (error) { if (!missingMessage(error)) throw error; }
      }
      if (response) {
        const components = payload.components ?? (response.flags.has(MessageFlags.IsComponentsV2) && payload.content
          ? [{ type: ComponentType.TextDisplay as const, content: payload.content }] : []);
        const v2 = components.length > 0;
        response = await response.edit({
          content: v2 ? null : payload.content ?? null,
          embeds: [], components,
          files: payload.files, attachments: [],
          flags: v2 ? MessageFlags.IsComponentsV2 : undefined,
          allowedMentions: { parse: [], repliedUser: false },
        });
      } else {
        if (quoted) {
          const channel = message.channel;
          if (!channel.isTextBased() || channel.isDMBased()) throw new Error("Expansion destination unavailable");
          response = await channel.send(payload);
        } else response = await message.reply(payload);
      }
      written = response;
      await this.repository.save({
        source_message_id: message.id, expansion_key: key, response_message_id: response.id,
        quoted_channel_id: quoted?.channelId ?? null, quoted_message_id: quoted?.id ?? null,
        quoted_hash: quoted ? quotedHash(quoted) : null,
      });
      if (options?.retry) session.failures.add(key);
      else session.failures.delete(key);
      return response;
    } catch (error) {
      if (error instanceof CyclicQuoteError) { session.seen.delete(key); throw error; }
      session.failures.add(key);
      if (written) await written.delete().catch((cleanupError) => {
        this.ctx.log.warn({ err: String(cleanupError), messageId: written!.id }, "untracked expansion cleanup failed");
      });
      throw error;
    }
  }

  async onCreate(message: Message): Promise<void> {
    if (this.stopped || !message.guildId || message.author?.bot) return;
    await this.serial(message.id, async () => {
      if (this.stopped) return;
      await this.renderSource(message, await this.repository.source(message.id));
    });
  }

  private async renderSource(message: Message, source?: ExpansionSource): Promise<void> {
    if (this.stopped || message.author?.bot) return;
    const records = source ? await this.repository.records(message.id) : [];
    const session: RenderSession = {
      source, hash: sourceHash(message), records,
      seen: new Set(), deleted: new Set(), failures: new Set(),
      references: new Set(records.flatMap((record) => record.quoted_message_id ? [record.quoted_message_id] : [])),
    };
    this.sessions.set(message.id, session);
    try {
      await this.render(message);
      if (!session.source || session.failures.size > 0 || session.deleted.size > 0
        || new Date(session.source.expires_at).getTime() <= Date.now()) return;
      for (const record of session.records) {
        if (!session.seen.has(record.expansion_key)) await this.remove(record, session.source.channel_id);
      }
      await this.repository.markRendered(message.id, session.hash);
    } catch (error) {
      // 最初の取得で失敗した引用も、期限内の定期確認で再試行する。
      if (!session.source) await this.repository.register(message);
      throw error;
    } finally { this.sessions.delete(message.id); }
  }

  private async refresh(source: ExpansionSource): Promise<void> {
    await this.serial(source.message_id, async () => {
      const active = await this.repository.source(source.message_id);
      if (this.stopped || !active) return;
      let message: Message;
      try { message = await this.fetchMessage(source.channel_id, source.message_id); }
      catch (error) {
        if (missingMessage(error)) { await this.removeSource(active); return; }
        throw error;
      }
      let changed = active.content_hash !== sourceHash(message);
      if (!changed) {
        for (const record of await this.repository.records(source.message_id)) {
          if (!record.quoted_message_id || !record.quoted_channel_id) continue;
          try {
            const quote = await this.fetchMessage(record.quoted_channel_id, record.quoted_message_id);
            if (quotedHash(quote) !== record.quoted_hash) changed = true;
          } catch (error) {
            if (!missingMessage(error)) throw error;
            await this.remove(record, source.channel_id);
          }
        }
      }
      if (changed) await this.renderSource(message, active);
    });
  }

  async onUpdate(message: { id: string }): Promise<void> {
    if (this.stopped) return;
    const rendering = [...this.sessions.entries()].filter(([, session]) => session.references.has(message.id));
    await this.pending.get(message.id)?.catch(() => undefined);
    for (const [id] of rendering) await this.pending.get(id)?.catch(() => undefined);
    const affected = new Map((await this.repository.affected(message.id)).map((source) => [source.message_id, source]));
    for (const [, session] of rendering) {
      if (session.source) affected.set(session.source.message_id, session.source);
    }
    for (const source of affected.values()) {
      await this.refresh(source);
    }
  }

  /** 追跡前の投稿が編集でリンクを得た場合に、新規投稿と同じ経路で展開する。 */
  async onUntrackedUpdate(message: Message): Promise<void> {
    if (this.stopped || !message.guildId || message.author?.bot) return;
    if (Date.now() - message.createdTimestamp >= EXPANSION_TTL_MS) return;
    await this.serial(message.id, async () => {
      if (this.stopped || await this.repository.source(message.id)) return;
      await this.renderSource(message);
    });
  }

  async onDelete(message: { id: string }): Promise<void> {
    if (this.stopped) return;
    const inFlight = new Set<string>();
    if (this.pending.has(message.id)) inFlight.add(message.id);
    for (const [sourceId, session] of this.sessions) {
      if (sourceId === message.id || session.references.has(message.id)) {
        session.deleted.add(message.id);
        inFlight.add(sourceId);
      }
    }
    const affected = await this.repository.affected(message.id, true);
    // register()/save() の完了前に届いた削除も、進行中の処理を待ってから探し直す。
    const ids = new Set([...affected.map((source) => source.message_id), ...inFlight]);
    for (const id of ids) {
      await this.serial(id, async () => {
        const source = await this.repository.source(id);
        if (!source) return;
        if (id === message.id) { await this.removeSource(source); return; }
        for (const record of await this.repository.records(id)) {
          if (record.quoted_message_id === message.id) await this.remove(record, source.channel_id);
          else if (record.response_message_id === message.id) await this.repository.forgetResponse(message.id);
        }
      });
    }
  }

  async reconcile(): Promise<void> {
    if (this.stopped || this.reconciling) return;
    this.reconciling = true;
    try {
      await this.repository.cleanup();
      let after = "";
      while (!this.stopped) {
        const sources = await this.repository.page(after);
        if (sources.length === 0) break;
        for (const source of sources) {
          if (this.stopped) return;
          try { await this.refresh(source); }
          catch (error) { this.ctx.log.warn({ err: String(error), messageId: source.message_id }, "expansion reconciliation failed"); }
        }
        after = sources[sources.length - 1]!.message_id;
      }
    } finally { this.reconciling = false; }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.pending.values()]);
  }
}

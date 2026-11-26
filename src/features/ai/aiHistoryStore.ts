import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { AiHistoryDatabase } from "../../core/db/types.js";
import type { ChatMessage } from "./chatTypes.js";

export type AiHistoryMode = "normal" | "r18" | "optimizer";

function parseHistoryMeta(meta: unknown): Record<string, unknown> {
  if (!meta) return {};
  if (typeof meta === "object" && !Array.isArray(meta)) {
    return meta as Record<string, unknown>;
  }
  if (typeof meta !== "string") return {};
  try {
    const parsed = JSON.parse(meta) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {}
  return {};
}

export function shouldIncludeHistoryMeta(metaValue: unknown, mode: AiHistoryMode): boolean {
  const meta = parseHistoryMeta(metaValue);
  const isR18 = meta.r18 === true;
  const isLocalLlm = meta.provider === "local_llm";
  if (mode === "r18") return isR18;
  return !isR18 && !isLocalLlm;
}

function normalizeOptimizerMaxRows(maxRows: number): number {
  if (!Number.isFinite(maxRows) || maxRows < 1) return 0;
  const floored = Math.floor(maxRows);
  return floored < 2 ? 2 : floored - (floored % 2);
}

/**
 * オプティマイザー用の履歴ウィンドウを切り出す。
 * user/assistant の組単位に揃えるため、奇数の maxRows は偶数へ切り下げ、
 * 1 は 2 に繰り上げ、先頭の孤立 assistant 行は除外される。
 */
export function trimOptimizerWindow<T extends { role: string; content: string; meta?: unknown }>(
  rowsAsc: T[],
  maxRows: number,
): { role: string; content: string }[] {
  const pairAlignedMax = normalizeOptimizerMaxRows(maxRows);
  if (pairAlignedMax <= 0) return [];
  const filtered = rowsAsc.filter((row) => shouldIncludeHistoryMeta(row.meta, "optimizer"));
  const sliced = filtered.slice(-pairAlignedMax);
  const startIndex = sliced.length > 0 && sliced[0]?.role === "assistant" ? 1 : 0;
  return sliced.slice(startIndex).map(({ role, content }) => ({ role, content }));
}

const MAX_OPTIMIZER_WINDOW_PAGES = 5;

export class AiHistoryStore {
  constructor(private readonly db: Kysely<AiHistoryDatabase>) {}

  async countSince(
    guildId: string,
    userId: string,
    since: Date | null,
    mode: AiHistoryMode = "normal",
  ): Promise<number> {
    let query = this.db
      .selectFrom("ai_history")
      .select(["id", "meta"])
      .where("guild_id", "=", guildId)
      .where("user_id", "=", userId);
    if (since) {
      query = query.where("created_at", ">", since);
    }
    const rows = await query.execute();
    return rows.filter((row) => shouldIncludeHistoryMeta(row.meta, mode)).length;
  }

  /**
   * オプティマイザー用の直近履歴ウィンドウを読み込む。
   * user/assistant の組単位に揃えるため、奇数の maxRows は偶数へ切り下げ、
   * 1 は 2 に繰り上げ、先頭の孤立 assistant 行は除外される。
   */
  async loadWindowForOptimizer(
    guildId: string,
    userId: string,
    since: Date | null,
    maxRows: number,
  ): Promise<{ role: string; content: string }[]> {
    const pairAlignedMax = normalizeOptimizerMaxRows(maxRows);
    if (pairAlignedMax <= 0) return [];
    const fetchLimit = Math.max(pairAlignedMax * 2, pairAlignedMax + 10);
    const collectedDesc: { role: string; content: string; meta: unknown }[] = [];
    let cursor: { created_at_text: string; role: string; id: string } | null = null;

    for (let page = 0; page < MAX_OPTIMIZER_WINDOW_PAGES; page += 1) {
      let query = this.db
        .selectFrom("ai_history")
        .select(["id", "role", "content", "meta", sql<string>`created_at::text`.as("created_at_text")])
        .where("guild_id", "=", guildId)
        .where("user_id", "=", userId)
        .where(sql<boolean>`(meta->'r18') IS DISTINCT FROM 'true'::jsonb`)
        .where(sql<boolean>`(meta->'provider') IS DISTINCT FROM '"local_llm"'::jsonb`)
        .orderBy("created_at", "desc")
        .orderBy("role", "asc")
        .orderBy("id", "desc")
        .limit(fetchLimit);
      if (since) {
        query = query.where("created_at", ">", since);
      }
      if (cursor) {
        const c = cursor;
        query = query.where((eb) =>
          eb.or([
            sql<boolean>`created_at < ${c.created_at_text}::timestamptz`,
            eb.and([
              sql<boolean>`created_at = ${c.created_at_text}::timestamptz`,
              eb("role", ">", c.role),
            ]),
            eb.and([
              sql<boolean>`created_at = ${c.created_at_text}::timestamptz`,
              eb("role", "=", c.role),
              eb("id", "<", c.id),
            ]),
          ]),
        );
      }
      const rows = await query.execute();
      if (rows.length === 0) break;

      for (const row of rows) {
        if (shouldIncludeHistoryMeta(row.meta, "optimizer")) {
          collectedDesc.push({ role: row.role, content: row.content, meta: row.meta });
          if (collectedDesc.length >= pairAlignedMax) break;
        }
      }

      if (collectedDesc.length >= pairAlignedMax || rows.length < fetchLimit) {
        break;
      }

      const last = rows[rows.length - 1]!;
      cursor = {
        created_at_text: last.created_at_text,
        role: last.role,
        id: last.id,
      };
    }

    return trimOptimizerWindow([...collectedDesc].reverse(), pairAlignedMax);
  }

  async loadMessages(
    guildId: string,
    userId: string,
    since: Date | null,
    mode: AiHistoryMode,
    maxMessages: number,
  ): Promise<ChatMessage[]> {
    let query = this.db
      .selectFrom("ai_history")
      .select(["role", "content", "meta"])
      .where("guild_id", "=", guildId)
      .where("user_id", "=", userId)
      .orderBy("created_at", "asc")
      .orderBy("role", "desc");
    if (since) {
      query = query.where("created_at", ">", since);
    }
    const rows = await query.execute();

    const out: ChatMessage[] = [];
    for (const r of rows) {
      if (!shouldIncludeHistoryMeta(r.meta, mode)) continue;
      if (r.role === "user" || r.role === "assistant") {
        out.push({ role: r.role, content: r.content });
      }
    }
    return out.slice(-maxMessages);
  }

  async appendPair(
    guildId: string,
    userId: string,
    userContent: string,
    assistantContent: string,
    metaValue: Record<string, unknown> = {},
  ): Promise<void> {
    const userCreatedAt = new Date();
    const assistantCreatedAt = new Date(userCreatedAt.getTime() + 1);
    await this.db
      .insertInto("ai_history")
      .values([
        {
          id: randomUUID(),
          guild_id: guildId,
          user_id: userId,
          role: "user",
          content: userContent.slice(0, 4000),
          meta: metaValue,
          created_at: userCreatedAt,
        },
        {
          id: randomUUID(),
          guild_id: guildId,
          user_id: userId,
          role: "assistant",
          content: assistantContent.slice(0, 4000),
          meta: metaValue,
          created_at: assistantCreatedAt,
        },
      ])
      .execute();
  }

  async clear(guildId: string, userId: string): Promise<void> {
    await this.db
      .deleteFrom("ai_history")
      .where("guild_id", "=", guildId)
      .where("user_id", "=", userId)
      .execute();
  }
}

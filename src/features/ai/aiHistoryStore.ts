import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
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

  async loadWindowForOptimizer(
    guildId: string,
    userId: string,
    since: Date | null,
    maxRows: number,
  ): Promise<{ role: string; content: string }[]> {
    let query = this.db
      .selectFrom("ai_history")
      .select(["role", "content", "meta"])
      .where("guild_id", "=", guildId)
      .where("user_id", "=", userId)
      .orderBy("created_at", "desc")
      .orderBy("role", "asc")
      .limit(maxRows);
    if (since) {
      query = query.where("created_at", ">", since);
    }
    const rows = await query.execute();
    return [...rows].reverse().filter((row) => shouldIncludeHistoryMeta(row.meta, "optimizer"));
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

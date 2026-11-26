import { sql } from "kysely";
import type { CoreDeps } from "../../core/deps.js";

// TicketUsage が使う依存。
type TicketUsageDeps = Pick<CoreDeps, "ticketDb" | "log">;


export type TicketUsageSummary = {
  userId: string;
  modmailCount: number;
  appealCount: number;
  totalCount: number;
  lastUsedAt: string | null;
};

type CountRow = {
  user_id: string;
  count: string;
  last_at: string | null;
};

function getOrCreateSummary(map: Map<string, TicketUsageSummary>, userId: string): TicketUsageSummary {
  const existing = map.get(userId);
  if (existing) return existing;
  const created = {
    userId,
    modmailCount: 0,
    appealCount: 0,
    totalCount: 0,
    lastUsedAt: null,
  };
  map.set(userId, created);
  return created;
}

function newerTimestamp(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

function timestampSortValue(value: string | null): number {
  if (!value) return 0;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

export async function listTicketUsageSummaries(
  ctx: TicketUsageDeps,
  guildId: string,
  limit = 25,
): Promise<TicketUsageSummary[]> {
  const [modmailRows, appealRows] = await Promise.all([
    ctx.ticketDb
      .selectFrom("modmail_threads")
      .select([
        "user_id",
        sql<string>`cast(count(*) as text)`.as("count"),
        sql<string | null>`max(created_at)`.as("last_at"),
      ])
      .where("guild_id", "=", guildId)
      .groupBy("user_id")
      .execute() as Promise<CountRow[]>,
    ctx.ticketDb
      .selectFrom("appeals")
      .select([
        "user_id",
        sql<string>`cast(count(*) as text)`.as("count"),
        sql<string | null>`max(created_at)`.as("last_at"),
      ])
      .where("guild_id", "=", guildId)
      .groupBy("user_id")
      .execute() as Promise<CountRow[]>,
  ]);

  const byUser = new Map<string, TicketUsageSummary>();

  for (const row of modmailRows) {
    const summary = getOrCreateSummary(byUser, row.user_id);
    summary.modmailCount += Number(row.count) || 0;
    summary.lastUsedAt = newerTimestamp(summary.lastUsedAt, row.last_at);
  }

  for (const row of appealRows) {
    const summary = getOrCreateSummary(byUser, row.user_id);
    summary.appealCount += Number(row.count) || 0;
    summary.lastUsedAt = newerTimestamp(summary.lastUsedAt, row.last_at);
  }

  return [...byUser.values()]
    .map((summary) => ({
      ...summary,
      totalCount: summary.modmailCount + summary.appealCount,
    }))
    .sort((a, b) => {
      if (b.totalCount !== a.totalCount) return b.totalCount - a.totalCount;
      return timestampSortValue(b.lastUsedAt) - timestampSortValue(a.lastUsedAt);
    })
    .slice(0, Math.max(1, limit));
}

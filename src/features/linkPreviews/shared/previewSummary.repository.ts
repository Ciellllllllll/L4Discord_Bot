import type { Kysely } from "kysely";
import type { Database } from "../../../core/db/types.js";
import type { PgQueryable } from "../../../core/db/postgres.js";
import type { PreviewSummaryDecision } from "./previewSummaryGate.js";

/** 展開の追跡期間（7日）と揃える。同じページの要約は期間内なら AI に問い合わせ直さない */
const PREVIEW_SUMMARY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

type RepositoryDeps = {
  now?: () => Date;
};

export async function getPreviewSummary(
  db: Kysely<Database>,
  sourceUrl: string,
  deps: RepositoryDeps = {},
): Promise<PreviewSummaryDecision | null> {
  const row = await db.selectFrom("preview_summaries")
    .selectAll()
    .where("source_url", "=", sourceUrl)
    .where("expires_at", ">", deps.now?.() ?? new Date())
    .executeTakeFirst();
  if (!row) return null;
  return {
    shouldSummarize: row.should_summarize,
    summary: row.summary,
    ...(row.model ? { model: row.model } : {}),
  };
}

export async function savePreviewSummary(
  db: Kysely<Database>,
  sourceUrl: string,
  decision: PreviewSummaryDecision,
  deps: RepositoryDeps = {},
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  const expiresAt = new Date(now.getTime() + PREVIEW_SUMMARY_TTL_MS);
  const values = {
    should_summarize: decision.shouldSummarize,
    summary: decision.summary,
    model: decision.model ?? null,
    expires_at: expiresAt,
    updated_at: now,
  };
  await db.insertInto("preview_summaries")
    .values({ source_url: sourceUrl, ...values, created_at: now })
    .onConflict((conflict) => conflict.column("source_url").doUpdateSet(values))
    .execute();
}

export async function deleteExpiredPreviewSummaries(
  db: Kysely<Database>,
  deps: RepositoryDeps = {},
): Promise<number> {
  const result = await db.deleteFrom("preview_summaries")
    .where("expires_at", "<=", deps.now?.() ?? new Date())
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0n);
}

export async function ensurePostgresPreviewSummarySchema(pool: PgQueryable): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS preview_summaries (
      source_url text PRIMARY KEY,
      should_summarize boolean NOT NULL,
      summary text NOT NULL,
      model text,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_preview_summaries_expires
      ON preview_summaries (expires_at);
  `);
}

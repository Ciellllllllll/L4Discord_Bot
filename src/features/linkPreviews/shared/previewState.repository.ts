import type { Kysely } from "kysely";
import { z } from "zod";
import type { Database } from "../../../core/db/types.js";
import type { PgQueryable } from "../../../core/db/postgres.js";
import type { PreviewDocument, PreviewSource } from "./previewDocument.js";
import type { PreviewDocumentTranslations } from "./previewTranslationGate.js";

const PREVIEW_STATE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

type LoggerLike = {
  warn: (obj: unknown, msg?: string) => void;
};

type RepositoryDeps = {
  now?: () => Date;
  log?: LoggerLike;
};

export type PreviewTranslationStateV1 = {
  version: 1;
  messageId: string;
  guildId: string;
  channelId: string;
  sourceUrl: string;
  document: PreviewDocument;
  translations: PreviewDocumentTranslations;
};

export type LegacyPreviewTranslationState = {
  version: 0;
  messageId: string;
  guildId: string;
  channelId: string;
  sourceUrl: string;
  document: {
    version: 0;
    source: "x";
    legacyTweet: Record<string, unknown>;
  };
  translations: {
    version: 0;
    source: "x";
    legacyTranslations: Record<string, unknown>;
  };
};

export type PreviewTranslationState = PreviewTranslationStateV1 | LegacyPreviewTranslationState;

const boundedString = (max: number) => z.string().min(1).max(max);
const httpsUrl = z.string().url().max(2_048).refine((value) => new URL(value).protocol === "https:", "HTTPS URL required");
const sourceSchema = z.enum(["x", "youtube"]);

const textPartSchema = z.object({
  text: z.string().max(4_000),
  translationKey: boundedString(128).optional(),
  strong: z.boolean().optional(),
}).passthrough();

const textLineSchema = z.object({
  prefix: z.string().max(512).optional(),
  parts: z.array(textPartSchema).max(50),
}).passthrough();

const textBlockSchema = z.object({
  type: z.literal("text"),
  id: boundedString(128),
  lines: z.array(textLineSchema).max(50),
  thumbnailUrl: httpsUrl.optional(),
  thumbnailDescription: z.string().max(1_024).optional(),
}).passthrough();

const mediaBlockSchema = z.object({
  type: z.literal("media"),
  id: boundedString(128),
  items: z.array(z.object({
    url: httpsUrl,
    description: z.string().max(1_024).optional(),
    spoiler: z.boolean().optional(),
  }).passthrough()).max(10),
}).passthrough();

const documentSchema = z.object({
  version: z.literal(1),
  source: sourceSchema,
  url: httpsUrl,
  openLabel: boundedString(100),
  blocks: z.array(z.discriminatedUnion("type", [textBlockSchema, mediaBlockSchema])).max(25),
}).passthrough();

const decisionSchema = z.object({
  shouldTranslate: z.boolean(),
  sourceLanguage: z.string().max(64),
  confidence: z.number().finite().min(0).max(1),
  translatedText: boundedString(4_000),
}).passthrough();

const decisionsSchema = z.record(boundedString(128), decisionSchema)
  .superRefine((value, context) => {
    const entries = Object.entries(value);
    if (entries.length === 0 || entries.length > 100) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "translations must contain 1..100 entries" });
    }
    if (!entries.some(([, decision]) => decision.shouldTranslate && decision.translatedText.trim().length > 0)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "a useful translation is required" });
    }
  });

const storedTranslationsV1Schema = z.object({
  version: z.literal(1),
  source: sourceSchema,
  model: boundedString(120).optional(),
  translations: decisionsSchema,
}).passthrough();

const legacyDocumentSchema = z.object({
  version: z.literal(0),
  source: z.literal("x"),
  legacyTweet: z.record(z.unknown()),
}).passthrough();

const legacyTranslationsSchema = z.object({
  version: z.literal(0),
  source: z.literal("x"),
  legacyTranslations: z.record(z.unknown()),
}).passthrough();

const rowBaseSchema = z.object({
  message_id: boundedString(100),
  guild_id: boundedString(100),
  channel_id: boundedString(100),
  source_kind: sourceSchema,
  source_url: httpsUrl,
  document: z.unknown(),
  translations: z.unknown(),
}).passthrough();

const stateV1Schema = z.object({
  version: z.literal(1),
  messageId: boundedString(100),
  guildId: boundedString(100),
  channelId: boundedString(100),
  sourceUrl: httpsUrl,
  document: documentSchema,
  translations: z.object({
    model: boundedString(120).optional(),
    translations: decisionsSchema,
  }).passthrough(),
}).passthrough().superRefine((value, context) => {
  if (value.sourceUrl !== value.document.url) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "source URL and document URL differ" });
  }
});

function warnInvalid(log: LoggerLike | undefined, messageId: unknown, reason: unknown): null {
  log?.warn({ messageId, reason }, "invalid preview translation state ignored");
  return null;
}

export function parsePreviewTranslationStateRow(
  input: unknown,
  log?: LoggerLike,
): PreviewTranslationState | null {
  const base = rowBaseSchema.safeParse(input);
  if (!base.success) return warnInvalid(log, (input as { message_id?: unknown } | null)?.message_id, base.error.flatten());
  const row = base.data;

  const documentV1 = documentSchema.safeParse(row.document);
  const translationsV1 = storedTranslationsV1Schema.safeParse(row.translations);
  if (documentV1.success && translationsV1.success) {
    if (
      row.source_kind !== documentV1.data.source
      || row.source_kind !== translationsV1.data.source
      || row.source_url !== documentV1.data.url
    ) {
      return warnInvalid(log, row.message_id, "source mismatch");
    }
    const { version: _version, source: _source, ...publicTranslations } = translationsV1.data;
    const parsed = stateV1Schema.safeParse({
      version: 1,
      messageId: row.message_id,
      guildId: row.guild_id,
      channelId: row.channel_id,
      sourceUrl: row.source_url,
      document: documentV1.data,
      translations: publicTranslations,
    });
    return parsed.success
      ? parsed.data as PreviewTranslationStateV1
      : warnInvalid(log, row.message_id, parsed.error.flatten());
  }

  const legacyDocument = legacyDocumentSchema.safeParse(row.document);
  const legacyTranslations = legacyTranslationsSchema.safeParse(row.translations);
  if (
    row.source_kind === "x"
    && legacyDocument.success
    && legacyTranslations.success
  ) {
    return {
      version: 0,
      messageId: row.message_id,
      guildId: row.guild_id,
      channelId: row.channel_id,
      sourceUrl: row.source_url,
      document: legacyDocument.data,
      translations: legacyTranslations.data,
    };
  }
  return warnInvalid(log, row.message_id, "unsupported document or translation version");
}

export async function savePreviewTranslationState(
  db: Kysely<Database>,
  state: PreviewTranslationStateV1,
  deps: RepositoryDeps = {},
): Promise<void> {
  const parsed = stateV1Schema.safeParse(state);
  if (!parsed.success) throw new Error(`Invalid preview translation state: ${parsed.error.message}`);
  const value = parsed.data;
  const now = deps.now?.() ?? new Date();
  const expiresAt = new Date(now.getTime() + PREVIEW_STATE_TTL_MS);
  const source = value.document.source as PreviewSource;
  const storedTranslations = {
    version: 1 as const,
    source,
    ...value.translations,
  };
  await db.insertInto("preview_translation_states").values({
    message_id: value.messageId,
    guild_id: value.guildId,
    channel_id: value.channelId,
    source_kind: source,
    source_url: value.sourceUrl,
    document: value.document as unknown as Record<string, unknown>,
    translations: storedTranslations as unknown as Record<string, unknown>,
    expires_at: expiresAt,
    created_at: now,
    updated_at: now,
  }).onConflict((conflict) => conflict.column("message_id").doUpdateSet({
    guild_id: value.guildId,
    channel_id: value.channelId,
    source_kind: source,
    source_url: value.sourceUrl,
    document: value.document as unknown as Record<string, unknown>,
    translations: storedTranslations as unknown as Record<string, unknown>,
    expires_at: expiresAt,
    updated_at: now,
  })).execute();
}

export async function getPreviewTranslationState(
  db: Kysely<Database>,
  messageId: string,
  deps: RepositoryDeps = {},
): Promise<PreviewTranslationState | null> {
  const now = deps.now?.() ?? new Date();
  const row = await db.selectFrom("preview_translation_states")
    .selectAll()
    .where("message_id", "=", messageId)
    .where("expires_at", ">", now)
    .executeTakeFirst();
  return row ? parsePreviewTranslationStateRow(row, deps.log) : null;
}

export async function deleteExpiredPreviewTranslationStates(
  db: Kysely<Database>,
  deps: Pick<RepositoryDeps, "now"> = {},
): Promise<number> {
  const result = await db.deleteFrom("preview_translation_states")
    .where("expires_at", "<=", deps.now?.() ?? new Date())
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0n);
}

export async function migratePostgresPreviewTranslationStates(pool: PgQueryable): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS preview_translation_states (
      message_id text PRIMARY KEY,
      guild_id text NOT NULL,
      channel_id text NOT NULL,
      source_kind text NOT NULL CHECK (source_kind IN ('x', 'youtube')),
      source_url text NOT NULL,
      document jsonb NOT NULL,
      translations jsonb NOT NULL,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_preview_translation_states_expires
      ON preview_translation_states (expires_at);

    DO $preview_state_migration$
    BEGIN
      IF to_regclass('vx_twitter_preview_states') IS NOT NULL THEN
        EXECUTE $legacy_backfill$
          INSERT INTO preview_translation_states (
            message_id, guild_id, channel_id, source_kind, source_url,
            document, translations, expires_at, created_at, updated_at
          )
          SELECT message_id, guild_id, channel_id, 'x', tweet_url,
            jsonb_build_object('version', 0, 'source', 'x', 'legacyTweet', tweet),
            jsonb_build_object('version', 0, 'source', 'x', 'legacyTranslations', translations),
            expires_at, created_at, updated_at
          FROM vx_twitter_preview_states
          WHERE expires_at > CURRENT_TIMESTAMP
          ON CONFLICT (message_id) DO NOTHING
        $legacy_backfill$;
      END IF;
    END
    $preview_state_migration$;
  `);
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { ensurePostgresMainSchema } from "../../../core/db/postgresMainSchema.js";
import { createPgPool, quotePgIdent } from "../../../core/db/postgres.js";
import { getOptionalPostgresTestUrl } from "../../../test/postgresTestEnv.js";
import type { PreviewDocument } from "./previewDocument.js";
import type { PreviewDocumentTranslations } from "./previewTranslationGate.js";
import {
  deleteExpiredPreviewTranslationStates,
  getPreviewTranslationState,
  migratePostgresPreviewTranslationStates,
  migratePostgresGithubPreviewSupport,
  savePreviewTranslationState,
  type PreviewTranslationStateV1,
} from "./previewState.repository.js";

const NOW = new Date("2026-08-17T00:00:00.000Z");

const document: PreviewDocument = {
  version: 1,
  source: "youtube",
  url: "https://www.youtube.com/watch?v=abcdefghijk",
  openLabel: "YouTubeで開く",
  blocks: [{
    type: "text",
    id: "summary",
    lines: [{ parts: [{ text: "Hello", translationKey: "title" }] }],
  }],
};

const translations: PreviewDocumentTranslations = {
  model: "test-model",
  translations: {
    title: {
      shouldTranslate: true,
      sourceLanguage: "en",
      confidence: 0.98,
      translatedText: "こんにちは",
    },
  },
};

const state: PreviewTranslationStateV1 = {
  version: 1,
  messageId: "message-1",
  guildId: "guild-1",
  channelId: "channel-1",
  sourceUrl: document.url,
  document,
  translations,
};

type Row = Record<string, unknown>;

function memoryDb(initial: Row[] = []) {
  const rows = new Map(initial.map((row) => [String(row.message_id), structuredClone(row)]));
  return {
    rows,
    insertInto(table: string) {
      assert.equal(table, "preview_translation_states");
      let values: Row;
      const query = {
        values(next: Row) { values = structuredClone(next); return query; },
        onConflict(callback: (builder: unknown) => unknown) {
          callback({
            column: (column: string) => ({
              doUpdateSet: (update: Row) => ({ column, update }),
            }),
          });
          return query;
        },
        async execute() { rows.set(String(values.message_id), structuredClone(values)); },
      };
      return query;
    },
    selectFrom(table: string) {
      assert.equal(table, "preview_translation_states");
      const conditions: Array<[string, string, unknown]> = [];
      const query = {
        selectAll() { return query; },
        where(column: string, operator: string, value: unknown) { conditions.push([column, operator, value]); return query; },
        async executeTakeFirst() {
          const messageId = conditions.find(([column]) => column === "message_id")?.[2];
          const row = rows.get(String(messageId));
          if (!row) return undefined;
          const threshold = conditions.find(([column]) => column === "expires_at")?.[2] as Date | undefined;
          if (threshold && (row.expires_at as Date) <= threshold) return undefined;
          return structuredClone(row);
        },
      };
      return query;
    },
    deleteFrom(table: string) {
      assert.equal(table, "preview_translation_states");
      let threshold = NOW;
      const query = {
        where(column: string, operator: string, value: Date) {
          assert.deepEqual([column, operator], ["expires_at", "<="]);
          threshold = value;
          return query;
        },
        async executeTakeFirst() {
          let count = 0n;
          for (const [messageId, row] of rows) {
            if ((row.expires_at as Date) <= threshold) {
              rows.delete(messageId);
              count += 1n;
            }
          }
          return { numDeletedRows: count };
        },
      };
      return query;
    },
  };
}

test("save stores a validated v1 state with a 30-day expiry and get restores it", async () => {
  const db = memoryDb();
  await savePreviewTranslationState(db as never, state, { now: () => NOW });

  const row = db.rows.get(state.messageId)!;
  assert.equal(row.source_kind, "youtube");
  assert.equal((row.expires_at as Date).toISOString(), "2026-09-16T00:00:00.000Z");
  assert.deepEqual(row.document, document);
  assert.deepEqual(row.translations, { version: 1, source: "youtube", ...translations });

  assert.deepEqual(
    await getPreviewTranslationState(db as never, state.messageId, { now: () => NOW }),
    state,
  );
});

test("save upserts the same message and starts a fresh 30-day expiry", async () => {
  const db = memoryDb();
  await savePreviewTranslationState(db as never, state, { now: () => NOW });
  const later = new Date("2026-08-18T00:00:00.000Z");
  await savePreviewTranslationState(db as never, {
    ...state,
    channelId: "channel-2",
  }, { now: () => later });

  assert.equal(db.rows.size, 1);
  assert.equal(db.rows.get(state.messageId)?.channel_id, "channel-2");
  assert.equal((db.rows.get(state.messageId)?.expires_at as Date).toISOString(), "2026-09-17T00:00:00.000Z");
});

test("get treats expired and malformed or source-mismatched JSON as a cache miss", async () => {
  const validDb = memoryDb();
  await savePreviewTranslationState(validDb as never, state, { now: () => NOW });
  const stored = validDb.rows.get(state.messageId)!;
  const warnings: unknown[] = [];

  stored.expires_at = new Date("2026-08-16T23:59:59.000Z");
  assert.equal(await getPreviewTranslationState(validDb as never, state.messageId, { now: () => NOW }), null);

  stored.expires_at = new Date("2026-09-01T00:00:00.000Z");
  stored.document = { ...document, source: "x" };
  assert.equal(await getPreviewTranslationState(validDb as never, state.messageId, {
    now: () => NOW,
    log: { warn: (value) => { warnings.push(value); } },
  }), null);

  stored.document = { ...document, version: 99 };
  assert.equal(await getPreviewTranslationState(validDb as never, state.messageId, {
    now: () => NOW,
    log: { warn: (value) => { warnings.push(value); } },
  }), null);
  assert.equal(warnings.length, 2);
});

test("get rejects unsafe URLs, oversized media, and confidence outside 0..1", async () => {
  const db = memoryDb();
  await savePreviewTranslationState(db as never, state, { now: () => NOW });
  const stored = db.rows.get(state.messageId)!;
  const invalidDocuments = [
    { ...document, url: "http://www.youtube.com/watch?v=abcdefghijk" },
    { ...document, blocks: [{ type: "media", id: "media", items: Array.from({ length: 11 }, (_, i) => ({ url: `https://example.com/${i}` })) }] },
  ];
  for (const invalid of invalidDocuments) {
    stored.document = invalid;
    assert.equal(await getPreviewTranslationState(db as never, state.messageId, { now: () => NOW }), null);
  }
  stored.document = document;
  stored.translations = {
    version: 1,
    source: "youtube",
    ...translations,
    translations: { title: { ...translations.translations.title, confidence: 2 } },
  };
  assert.equal(await getPreviewTranslationState(db as never, state.messageId, { now: () => NOW }), null);
});

test("get accepts bounded future fields within the known v1 shape", async () => {
  const db = memoryDb();
  await savePreviewTranslationState(db as never, state, { now: () => NOW });
  const stored = db.rows.get(state.messageId)!;
  stored.document = {
    ...document,
    futureDocumentField: "kept",
    blocks: [{
      ...(document.blocks[0] as Record<string, unknown>),
      futureBlockField: true,
    }],
  };
  const storedTranslations = stored.translations as any;
  stored.translations = {
    ...storedTranslations,
    futureBundleField: 1,
    translations: {
      title: { ...storedTranslations.translations.title, futureDecisionField: "kept" },
    },
  };
  const result = await getPreviewTranslationState(db as never, state.messageId, { now: () => NOW });
  assert.equal(result?.version, 1);
  if (result?.version === 1) {
    assert.equal((result.translations as PreviewDocumentTranslations & { futureBundleField?: number }).futureBundleField, 1);
  }
});

test("get returns explicit legacy v0 wrappers without passing them off as v1 documents", async () => {
  const db = memoryDb([{
    message_id: "legacy-message",
    guild_id: "guild-1",
    channel_id: "channel-1",
    source_kind: "x",
    source_url: "https://x.com/user/status/123",
    document: { version: 0, source: "x", legacyTweet: { id: "123", text: "hello" } },
    translations: { version: 0, source: "x", legacyTranslations: { main: { translatedText: "こんにちは" } } },
    expires_at: new Date("2026-09-01T00:00:00.000Z"),
    created_at: NOW,
    updated_at: NOW,
  }]);

  const result = await getPreviewTranslationState(db as never, "legacy-message", { now: () => NOW });
  assert.equal(result?.version, 0);
  if (result?.version === 0) assert.equal(result.document.legacyTweet.id, "123");
});

test("save refuses invalid v1 states before writing", async () => {
  const db = memoryDb();
  await assert.rejects(
    () => savePreviewTranslationState(db as never, {
      ...state,
      sourceUrl: "http://example.com/insecure",
    }, { now: () => NOW }),
    /invalid preview translation state/i,
  );
  assert.equal(db.rows.size, 0);
});

test("deleteExpired removes only rows at or before the requested time", async () => {
  const db = memoryDb([
    { message_id: "expired", expires_at: new Date("2026-08-17T00:00:00.000Z") },
    { message_id: "active", expires_at: new Date("2026-08-17T00:00:00.001Z") },
  ]);
  assert.equal(await deleteExpiredPreviewTranslationStates(db as never, { now: () => NOW }), 1);
  assert.deepEqual([...db.rows.keys()], ["active"]);
});

test("v15 migration creates the constrained state table and idempotently wraps unexpired legacy X rows", async () => {
  const queries: string[] = [];
  await migratePostgresPreviewTranslationStates({
    query: async (sql: string) => { queries.push(sql); return { rows: [], rowCount: 0 }; },
  } as never);
  const sql = queries.join("\n");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS preview_translation_states/i);
  assert.match(sql, /CHECK \(source_kind IN \('x', 'youtube', 'steam'\)\)/i);
  assert.match(sql, /idx_preview_translation_states_expires/i);
  assert.match(sql, /jsonb_build_object\('version', 0, 'source', 'x', 'legacyTweet', tweet\)/i);
  assert.match(sql, /jsonb_build_object\('version', 0, 'source', 'x', 'legacyTranslations', translations\)/i);
  assert.match(sql, /WHERE expires_at > CURRENT_TIMESTAMP/i);
  assert.match(sql, /ON CONFLICT \(message_id\) DO NOTHING/i);
  assert.match(sql, /to_regclass\('vx_twitter_preview_states'\)/i);
  assert.doesNotMatch(sql, /CURRENT_TIMESTAMP \+ interval '30 days'/i);
});

test("a newly created PostgreSQL main schema includes the common preview state table", async () => {
  const queries: string[] = [];
  await ensurePostgresMainSchema({
    query: async (sql: string) => { queries.push(sql); return { rows: [], rowCount: 0 }; },
  } as never);
  const sql = queries.join("\n");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS preview_translation_states/i);
  assert.match(sql, /CHECK \(source_kind IN \('x', 'youtube', 'steam', 'github'\)\)/i);
  assert.match(sql, /idx_preview_translation_states_expires/i);
});

test("v16 migration extends preview states to Steam", async () => {
  const { migratePostgresSteamPreviewSupport } = await import("./previewState.repository.js");
  const queries: string[] = [];
  await migratePostgresSteamPreviewSupport({
    query: async (sql: string) => { queries.push(sql); return { rows: [], rowCount: 0 }; },
  } as never);
  const sql = queries.join("\n");
  assert.match(sql, /DROP CONSTRAINT IF EXISTS preview_translation_states_source_kind_check/i);
  assert.match(sql, /CHECK \(source_kind IN \('x', 'youtube', 'steam'\)\)/i);
});

test("v18 migration extends preview states to GitHub", async () => {
  const queries: string[] = [];
  await migratePostgresGithubPreviewSupport({
    query: async (sql: string) => { queries.push(sql); return { rows: [], rowCount: 0 }; },
  } as never);
  const sql = queries.join("\n");
  assert.match(sql, /DROP CONSTRAINT IF EXISTS preview_translation_states_source_kind_check/i);
  assert.match(sql, /CHECK \(source_kind IN \('x', 'youtube', 'steam', 'github'\)\)/i);
});

test("v15 backfills only active X rows, preserves expiry, and does not overwrite on rerun", async () => {
  const connectionString = getOptionalPostgresTestUrl("TEST_DATABASE_URL", "previewState.repository.spec.ts");
  if (!connectionString) return;
  const schema = `preview_state_v15_${process.pid}_${Date.now()}`;
  const admin = await createPgPool(connectionString);
  const pool = await createPgPool(connectionString, schema);
  try {
    await pool.query(`
      CREATE TABLE vx_twitter_preview_states (
        message_id text PRIMARY KEY, guild_id text NOT NULL, channel_id text NOT NULL, tweet_url text NOT NULL,
        tweet jsonb NOT NULL, translations jsonb NOT NULL, expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO vx_twitter_preview_states
        (message_id, guild_id, channel_id, tweet_url, tweet, translations, expires_at)
      VALUES
        ('active', 'guild', 'channel', 'https://x.com/user/status/1', '{"id":"1"}', '{"model":"old"}', CURRENT_TIMESTAMP + interval '1 day'),
        ('expired', 'guild', 'channel', 'https://x.com/user/status/2', '{"id":"2"}', '{}', CURRENT_TIMESTAMP - interval '1 day');
    `);
    await migratePostgresPreviewTranslationStates(pool);
    const first = await pool.query<{
      message_id: string;
      source_kind: string;
      document: Record<string, unknown>;
      translations: Record<string, unknown>;
      same_expiry: boolean;
    }>(`
      SELECT common.message_id, common.source_kind, common.document, common.translations,
        common.expires_at = legacy.expires_at AS same_expiry
      FROM preview_translation_states AS common
      JOIN vx_twitter_preview_states AS legacy USING (message_id)
      ORDER BY common.message_id
    `);
    assert.equal(first.rowCount, 1);
    assert.equal(first.rows[0]?.message_id, "active");
    assert.equal(first.rows[0]?.source_kind, "x");
    assert.equal(first.rows[0]?.same_expiry, true);
    assert.deepEqual(first.rows[0]?.document, { version: 0, source: "x", legacyTweet: { id: "1" } });
    assert.deepEqual(first.rows[0]?.translations, { version: 0, source: "x", legacyTranslations: { model: "old" } });

    await pool.query(`UPDATE preview_translation_states SET document = document || '{"rerunProtected":true}'::jsonb WHERE message_id = 'active'`);
    await migratePostgresPreviewTranslationStates(pool);
    const rerun = await pool.query<{ count: string; protected: boolean }>(`
      SELECT COUNT(*)::text AS count, bool_and(document->>'rerunProtected' = 'true') AS protected
      FROM preview_translation_states
    `);
    assert.deepEqual(rerun.rows, [{ count: "1", protected: true }]);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quotePgIdent(schema)} CASCADE`);
    await admin.end();
  }
});

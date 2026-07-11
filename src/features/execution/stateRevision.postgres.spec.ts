import assert from "node:assert/strict";
import { Pool } from "pg";
import { createPostgresMainKysely } from "../../core/db/kysely.js";
import { getOptionalPostgresTestUrl } from "../../test/postgresTestEnv.js";
import { PollFlowStateStore, normalizePollStateRevision } from "./flowLifecycle.js";

assert.equal(normalizePollStateRevision("9"), 9);
assert.equal(normalizePollStateRevision("9007199254740992"), null);
assert.equal(normalizePollStateRevision("-1"), null);
assert.equal(normalizePollStateRevision("9.5"), null);

const connectionString = getOptionalPostgresTestUrl("TEST_DATABASE_URL", "stateRevision.postgres.spec.ts");
if (connectionString) {
  const schema = `state_revision_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  const adminPool = new Pool({ connectionString });
  const db = createPostgresMainKysely({ connectionString, schema });
  try {
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    await adminPool.query(`CREATE TABLE "${schema}".polls (
      id text PRIMARY KEY,
      guild_id text NOT NULL,
      status text NOT NULL,
      message_id text,
      kind text NOT NULL,
      state jsonb NOT NULL,
      state_revision bigint NOT NULL,
      updated_at timestamptz NOT NULL
    )`);
    await adminPool.query(
      `INSERT INTO "${schema}".polls (id, guild_id, status, kind, state, state_revision, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::bigint, now())`,
      ["revision-9", "guild", "open", "execution", JSON.stringify({ phase: "poll1_pending", votes: {} }), "9"],
    );

    const store = new PollFlowStateStore(db);
    const parse = (value: unknown) => value as { phase: string; votes: Record<string, string> };
    const first = await store.findOpen("revision-9", "execution", parse);
    assert.ok(first);
    assert.equal(first.stateRevision, 9, "pg bigint の文字列を安全な number に正規化する");
    assert.equal(await store.compareAndSwap({
      id: first.id,
      expectedPhase: first.state.phase,
      expectedRevision: first.stateRevision,
      expectedRawState: first.rawState,
      nextState: { phase: "poll1_pending", votes: { first: "yes" } },
    }), true);

    const second = await store.findOpen("revision-9", "execution", parse);
    assert.ok(second);
    assert.equal(second.stateRevision, 10);
    assert.equal(await store.compareAndSwap({
      id: second.id,
      expectedPhase: second.state.phase,
      expectedRevision: second.stateRevision,
      expectedRawState: second.rawState,
      nextState: { phase: "poll1_pending", votes: { first: "yes", second: "no" } },
    }), true);
    const revision = await adminPool.query<{ state_revision: string }>(`SELECT state_revision::text FROM "${schema}".polls WHERE id = $1`, ["revision-9"]);
    assert.equal(revision.rows[0]?.state_revision, "11", "複数回のCASで文字列連結せず数値として増分する");

    await adminPool.query(
      `INSERT INTO "${schema}".polls (id, guild_id, status, kind, state, state_revision, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::bigint, now())`,
      ["invalid-revision", "guild", "open", "execution", JSON.stringify({ phase: "poll1_pending", votes: {} }), "9007199254740992"],
    );
    assert.equal(await store.findOpen("invalid-revision", "execution", parse), null, "安全でないrevisionのフローは更新対象にしない");
  } finally {
    await db.destroy();
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool.end();
  }
}

console.log("stateRevision.postgres.spec.ts: all assertions passed");

import assert from "node:assert/strict";
import { createPgPool } from "../../core/db/postgres.js";
import { getOptionalPostgresTestUrl } from "../../test/postgresTestEnv.js";
import {
  closeBokeruRound,
  countBokeruOdaiUsage,
  createBokeruRound,
  ensurePostgresBokeruSchema,
  getBokeruAnswer,
  getBokeruBestAnswers,
  getBokeruUserRanking,
  insertBokeruAnswer,
  listDueBokeruRoundIds,
  setBokeruAnswerJudgement,
  toggleBokeruVote,
} from "./bokeruRepository.js";

const connectionString = getOptionalPostgresTestUrl("TEST_DATABASE_URL", "bokeruRepository.postgres.spec.ts");
if (connectionString) {
  const schema = `bokeru_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  const pool = await createPgPool(connectionString, schema);
  try {
    await ensurePostgresBokeruSchema(pool);
    await ensurePostgresBokeruSchema(pool);

    const odai = { id: "t1", type: "text", text: "お題" } as const;
    const future = new Date(Date.now() + 60_000);
    assert.equal(await createBokeruRound(pool, { id: "r1", guildId: "g", channelId: "c", odai, closesAt: future }), true);
    // 同じギルドで同時に出せるのは1題だけ。別ギルドは独立
    assert.equal(await createBokeruRound(pool, { id: "r2", guildId: "g", channelId: "c", odai, closesAt: future }), false);
    assert.equal(await createBokeruRound(pool, { id: "r3", guildId: "other", channelId: "c", odai, closesAt: future }), true);

    // 1お題につき1人1回
    assert.equal(await insertBokeruAnswer(pool, { id: "a1", roundId: "r1", userId: "alice", text: "ボケA" }), true);
    assert.equal(await insertBokeruAnswer(pool, { id: "a1b", roundId: "r1", userId: "alice", text: "二回目" }), false);
    assert.equal(await insertBokeruAnswer(pool, { id: "a2", roundId: "r1", userId: "bob", text: "ボケB" }), true);
    await setBokeruAnswerJudgement(pool, "a1", { score: 60, comment: "まあまあ" });
    await setBokeruAnswerJudgement(pool, "a2", null);

    // 自分の回答には投票できず、もう一度押すと取り消し
    assert.equal(await toggleBokeruVote(pool, "a1", "alice"), null);
    assert.deepEqual(await toggleBokeruVote(pool, "a2", "alice"), { voted: true, votes: 1 });
    assert.deepEqual(await toggleBokeruVote(pool, "a2", "carol"), { voted: true, votes: 2 });
    assert.deepEqual(await toggleBokeruVote(pool, "a2", "carol"), { voted: false, votes: 1 });
    assert.deepEqual(await toggleBokeruVote(pool, "a2", "carol"), { voted: true, votes: 2 });
    assert.deepEqual(await toggleBokeruVote(pool, "a1", "bob"), { voted: true, votes: 1 });
    assert.equal((await getBokeruAnswer(pool, "a2"))?.votes, 2);

    // 締切時刻を過ぎると回答・投票を受け付けず、締切対象に挙がる
    await pool.query("UPDATE bokeru_rounds SET closes_at = now() - interval '1 second' WHERE id = 'r1'");
    assert.equal(await insertBokeruAnswer(pool, { id: "a3", roundId: "r1", userId: "dave", text: "遅刻" }), false);
    assert.equal(await toggleBokeruVote(pool, "a1", "dave"), null);
    assert.deepEqual(await listDueBokeruRoundIds(pool), ["r1"]);

    // AI点 + 👍×10。AI採点失敗は0点。締切は1回だけ確定する
    const results = await closeBokeruRound(pool, "r1");
    assert.deepEqual(results?.map((r) => [r.id, r.final_score]), [["a1", 70], ["a2", 20]]);
    assert.equal(await closeBokeruRound(pool, "r1"), null);
    assert.deepEqual(await listDueBokeruRoundIds(pool), []);

    // 回答なしで締め切っても結果は空配列
    await pool.query("UPDATE bokeru_rounds SET closes_at = now() - interval '1 second' WHERE id = 'r3'");
    assert.deepEqual(await closeBokeruRound(pool, "r3"), []);

    assert.equal(await createBokeruRound(pool, { id: "r4", guildId: "g", channelId: "c", odai, closesAt: future }), true);
    assert.deepEqual(Object.fromEntries(await countBokeruOdaiUsage(pool, "g")), { t1: 2 });

    assert.deepEqual(await getBokeruUserRanking(pool, "g"), [
      { user_id: "alice", total: 70, answers: 1 },
      { user_id: "bob", total: 20, answers: 1 },
    ]);
    assert.deepEqual((await getBokeruBestAnswers(pool, "g")).map((r) => r.text), ["ボケA", "ボケB"]);
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await pool.end();
  }
}

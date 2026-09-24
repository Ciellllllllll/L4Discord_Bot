import assert from "node:assert/strict";
import { Pool } from "pg";
import { createPgPool } from "../../core/db/postgres.js";
import { createPostgresMainKysely } from "../../core/db/kysely.js";
import { getOptionalPostgresTestUrl } from "../../test/postgresTestEnv.js";
import { migratePostgresAnonymousSurveyFeedback } from "./surveySchema.js";
import { recordAnonymousSurveyAnswer, recordAnonymousSurveySkip } from "./surveyService.js";
import { getAnonymousSurveyView } from "./surveyView.js";

const connectionString = getOptionalPostgresTestUrl("TEST_DATABASE_URL", "surveyService.postgres.spec.ts");
if (connectionString) {
  const schema = `anonymous_survey_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  const pool = await createPgPool(connectionString, schema);
  const db = createPostgresMainKysely({ connectionString, schema });
  try {
    // 既存環境と同じ旧テーブル定義（rating NOT NULL、自由記述なし）から移行する
    await pool.query(`
      CREATE TABLE anonymous_survey_responses (
        id text PRIMARY KEY,
        guild_id text NOT NULL,
        rating integer NOT NULL CHECK (rating >= 1 AND rating <= 5),
        created_at timestamptz NOT NULL
      );
      CREATE TABLE anonymous_survey_user_state (
        guild_id text NOT NULL,
        user_id text NOT NULL,
        last_action text NOT NULL CHECK (last_action IN ('answer', 'skip')),
        next_prompt_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        PRIMARY KEY (guild_id, user_id)
      );
      INSERT INTO anonymous_survey_responses (id, guild_id, rating, created_at)
      VALUES ('legacy', 'guild', 2, '2026-09-01T00:00:00Z');
    `);
    await migratePostgresAnonymousSurveyFeedback(pool);
    await migratePostgresAnonymousSurveyFeedback(pool);

    await recordAnonymousSurveyAnswer(db, "guild", "user-a", { rating: 5, improvement: "  速くしてほしい  ", bugReport: null }, new Date("2026-09-02T00:00:00Z"));
    await recordAnonymousSurveyAnswer(db, "guild", "user-b", { rating: null, improvement: null, bugReport: "/foo が失敗する" }, new Date("2026-09-03T00:00:00Z"));
    await recordAnonymousSurveySkip(db, "guild", "user-c", new Date("2026-09-04T00:00:00Z"));
    await assert.rejects(
      recordAnonymousSurveyAnswer(db, "guild", "user-d", { rating: null, improvement: " ", bugReport: "" }),
      /rating or feedback/,
    );
    await assert.rejects(
      recordAnonymousSurveyAnswer(db, "guild", "user-d", { rating: 6, improvement: null, bugReport: null }),
      /integer from 1 to 5/,
    );

    const view = await getAnonymousSurveyView(db, "guild", 0);
    assert.equal(view.totalResponses, 3);
    assert.equal(view.averageRating, 3.5, "満足度未選択の回答は平均に含めない");
    assert.deepEqual(view.ratingCounts, [0, 1, 0, 0, 1]);
    assert.equal(view.improvementCount, 1);
    assert.equal(view.bugReportCount, 1);
    assert.deepEqual(view.responses.map(({ rating, improvement, bugReport }) => ({ rating, improvement, bugReport })), [
      { rating: null, improvement: null, bugReport: "/foo が失敗する" },
      { rating: 5, improvement: "速くしてほしい", bugReport: null },
      { rating: 2, improvement: null, bugReport: null },
    ]);

    const states = await pool.query<{ user_id: string; last_action: string }>(
      "SELECT user_id, last_action FROM anonymous_survey_user_state ORDER BY user_id",
    );
    assert.deepEqual(states.rows, [
      { user_id: "user-a", last_action: "answer" },
      { user_id: "user-b", last_action: "answer" },
      { user_id: "user-c", last_action: "skip" },
    ]);
  } finally {
    await db.destroy();
    await pool.end();
    const adminPool = new Pool({ connectionString });
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool.end();
  }
}

console.log("surveyService.postgres.spec.ts: all assertions passed");

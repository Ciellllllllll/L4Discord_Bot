import type { PgQueryable } from "../../core/db/postgres.js";

// 改善要望・バグ報告の自由記述を追加し、満足度未選択でも自由記述があれば保存できるようにする。
// テーブル本体は main_core_initial（ensurePostgresMainSchema）で作られる。
export async function migratePostgresAnonymousSurveyFeedback(pool: PgQueryable): Promise<void> {
  await pool.query(`
    ALTER TABLE IF EXISTS anonymous_survey_responses ADD COLUMN IF NOT EXISTS improvement text;
    ALTER TABLE IF EXISTS anonymous_survey_responses ADD COLUMN IF NOT EXISTS bug_report text;
    ALTER TABLE IF EXISTS anonymous_survey_responses ALTER COLUMN rating DROP NOT NULL;
  `);
}

import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createKysely } from "../../core/db/kysely.js";
import {
  SKIP_COOLDOWN_MS,
  canPromptAnonymousSurvey,
  ensureAnonymousSurveySchema,
  nextPromptAfterAnswer,
  recordAnonymousSurveyAnswer,
  recordAnonymousSurveySkip,
} from "./surveyService.js";

function makeDb() {
  const sqlite = new Database(":memory:");
  ensureAnonymousSurveySchema(sqlite);
  return { sqlite, db: createKysely(sqlite) };
}

async function run(): Promise<void> {
  {
    const { sqlite, db } = makeDb();
    try {
      const now = new Date("2026-07-07T00:00:00.000Z");
      assert.equal(await canPromptAnonymousSurvey(db, "guild", "user", now), true);

      await recordAnonymousSurveyAnswer(db, "guild", "user", 5, now);
      const answerCooldownEnd = nextPromptAfterAnswer(now);
      assert.equal(await canPromptAnonymousSurvey(db, "guild", "user", new Date(answerCooldownEnd.getTime() - 1)), false);
      assert.equal(await canPromptAnonymousSurvey(db, "guild", "user", answerCooldownEnd), true);
      assert.equal(nextPromptAfterAnswer(new Date("2026-01-31T12:00:00.000Z")).toISOString(), "2026-02-28T12:00:00.000Z");

      const rows = sqlite.prepare("SELECT * FROM anonymous_survey_responses").all() as Array<Record<string, unknown>>;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.guild_id, "guild");
      assert.equal(rows[0]?.rating, 5);
      assert.equal("user_id" in rows[0]!, false);
      assert.equal("command_name" in rows[0]!, false);
      assert.equal("channel_id" in rows[0]!, false);
    } finally {
      await db.destroy();
      sqlite.close();
    }
  }

  {
    const { sqlite, db } = makeDb();
    try {
      const now = new Date("2026-07-07T00:00:00.000Z");
      await recordAnonymousSurveySkip(db, "guild", "user", now);
      assert.equal(await canPromptAnonymousSurvey(db, "guild", "user", new Date(now.getTime() + SKIP_COOLDOWN_MS - 1)), false);
      assert.equal(await canPromptAnonymousSurvey(db, "guild", "user", new Date(now.getTime() + SKIP_COOLDOWN_MS)), true);
    } finally {
      await db.destroy();
      sqlite.close();
    }
  }
}

void run()
  .then(() => {
    console.log("surveyService.spec.ts: all assertions passed");
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

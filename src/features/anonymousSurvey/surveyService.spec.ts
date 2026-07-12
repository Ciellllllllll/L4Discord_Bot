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
  parseAnonymousSurveySessionPayload,
  getAnonymousSurveySession,
  consumeAnonymousSurveySession,
} from "./surveyService.js";

function makeDb() {
  const sqlite = new Database(":memory:");
  ensureAnonymousSurveySchema(sqlite);
  sqlite.exec("CREATE TABLE interaction_sessions (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, domain TEXT NOT NULL, action TEXT NOT NULL, payload TEXT NOT NULL, executor_user_id TEXT, expires_at TEXT NOT NULL, created_at TEXT NOT NULL)");
  return { sqlite, db: createKysely(sqlite) };
}

async function run(): Promise<void> {
  assert.deepEqual(parseAnonymousSurveySessionPayload({
    command: { commandName: "help", guildId: "guild", channelId: "channel", userId: "user", options: [] },
  }), {
    command: { commandName: "help", guildId: "guild", channelId: "channel", userId: "user", options: [] },
  });
  for (const invalid of ["{", null, [], {}, { command: { commandName: "help", guildId: "guild", channelId: "channel", userId: "user", options: [{ name: "bad", type: 3, value: {} }] } }]) {
    assert.equal(parseAnonymousSurveySessionPayload(invalid), null);
  }
  {
    const { sqlite, db } = makeDb();
    try {
      const insert = sqlite.prepare("INSERT INTO interaction_sessions (id, guild_id, domain, action, payload, executor_user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      insert.run("invalid-get", "guild", "anonymousSurvey", "slashGate", "{", "user", "2099-01-01T00:00:00.000Z", "now");
      assert.equal(await getAnonymousSurveySession(db, "invalid-get"), null);
      assert.equal(sqlite.prepare("SELECT 1 FROM interaction_sessions WHERE id = ?").get("invalid-get"), undefined);
      insert.run("invalid-consume", "guild", "anonymousSurvey", "slashGate", "{}", "user", "2099-01-01T00:00:00.000Z", "now");
      assert.equal(await consumeAnonymousSurveySession(db, "invalid-consume", "user"), null);
      assert.equal(sqlite.prepare("SELECT 1 FROM interaction_sessions WHERE id = ?").get("invalid-consume"), undefined);
      insert.run("mismatched-guild", "guild", "anonymousSurvey", "slashGate", JSON.stringify({ command: { commandName: "help", guildId: "other", channelId: "channel", userId: "user", options: [] } }), "user", "2099-01-01T00:00:00.000Z", "now");
      assert.equal(await getAnonymousSurveySession(db, "mismatched-guild"), null);
      assert.equal(sqlite.prepare("SELECT 1 FROM interaction_sessions WHERE id = ?").get("mismatched-guild"), undefined);
    } finally {
      await db.destroy();
    }
  }
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

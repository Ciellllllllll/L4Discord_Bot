import type DatabaseLib from "better-sqlite3";
import type { Kysely, Transaction } from "kysely";
import { ulid } from "ulid";
import { createSession, getSession } from "../../core/interactionSessions.js";
import type { Database } from "../../core/db/types.js";
import type { StoredSlashCommand } from "./surveyCommandState.js";

export const SKIP_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

export type AnonymousSurveyAction = "answer" | "skip";
type SurveyDb = Kysely<Database> | Transaction<Database>;

export type AnonymousSurveySessionPayload = {
  command: StoredSlashCommand;
};

function iso(date: Date): string {
  return date.toISOString();
}

export function ensureAnonymousSurveySchema(db: DatabaseLib.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS anonymous_survey_responses (
      id TEXT PRIMARY KEY NOT NULL,
      guild_id TEXT NOT NULL,
      rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS anonymous_survey_user_state (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      last_action TEXT NOT NULL CHECK (last_action IN ('answer', 'skip')),
      next_prompt_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
  `);
}

export async function canPromptAnonymousSurvey(
  db: Kysely<Database>,
  guildId: string,
  userId: string,
  now = new Date(),
): Promise<boolean> {
  const row = await db
    .selectFrom("anonymous_survey_user_state")
    .select("next_prompt_at")
    .where("guild_id", "=", guildId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (!row) return true;
  return new Date(row.next_prompt_at).getTime() <= now.getTime();
}

async function upsertUserState(
  db: SurveyDb,
  guildId: string,
  userId: string,
  action: AnonymousSurveyAction,
  nextPromptAt: Date,
  now: Date,
): Promise<void> {
  await db
    .insertInto("anonymous_survey_user_state")
    .values({
      guild_id: guildId,
      user_id: userId,
      last_action: action,
      next_prompt_at: iso(nextPromptAt) as unknown as Date,
      updated_at: iso(now) as unknown as Date,
    })
    .onConflict((oc) =>
      oc.columns(["guild_id", "user_id"]).doUpdateSet({
        last_action: action,
        next_prompt_at: iso(nextPromptAt) as unknown as Date,
        updated_at: iso(now) as unknown as Date,
      }),
    )
    .execute();
}

export function nextPromptAfterAnswer(now: Date): Date {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();
  const targetYear = month === 11 ? year + 1 : year;
  const targetMonth = (month + 1) % 12;
  const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    targetYear,
    targetMonth,
    Math.min(day, lastDayOfTargetMonth),
    now.getUTCHours(),
    now.getUTCMinutes(),
    now.getUTCSeconds(),
    now.getUTCMilliseconds(),
  ));
}

export async function recordAnonymousSurveyAnswer(
  db: Kysely<Database>,
  guildId: string,
  userId: string,
  rating: number,
  now = new Date(),
): Promise<void> {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new Error("anonymous survey rating must be an integer from 1 to 5");
  }
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto("anonymous_survey_responses")
      .values({
        id: ulid(),
        guild_id: guildId,
        rating,
        created_at: iso(now) as unknown as Date,
      })
      .execute();
    await upsertUserState(trx, guildId, userId, "answer", nextPromptAfterAnswer(now), now);
  });
}

export async function recordAnonymousSurveySkip(
  db: Kysely<Database>,
  guildId: string,
  userId: string,
  now = new Date(),
): Promise<void> {
  await upsertUserState(db, guildId, userId, "skip", new Date(now.getTime() + SKIP_COOLDOWN_MS), now);
}

export async function createAnonymousSurveySession(
  db: Kysely<Database>,
  guildId: string,
  userId: string,
  command: StoredSlashCommand,
): Promise<string> {
  const id = ulid();
  await createSession(db, {
    id,
    guildId,
    domain: "anonymousSurvey",
    action: "slashGate",
    payload: { command },
    executorUserId: userId,
    ttlHours: 1,
  });
  return id;
}

export async function getAnonymousSurveySession(
  db: Kysely<Database>,
  sessionId: string,
): Promise<AnonymousSurveySessionPayload & { guildId: string; executorUserId: string | null } | null> {
  const session = await getSession(db, sessionId);
  if (!session || session.domain !== "anonymousSurvey" || session.action !== "slashGate") return null;
  const payload = session.payload as unknown as AnonymousSurveySessionPayload;
  return {
    ...payload,
    guildId: session.guild_id,
    executorUserId: session.executor_user_id,
  };
}

function parseAnonymousSurveySessionRow(
  row: {
    payload: Record<string, unknown>;
    guild_id: string;
    executor_user_id: string | null;
  },
): AnonymousSurveySessionPayload & { guildId: string; executorUserId: string | null } {
  const p = row.payload;
  const payload = typeof p === "string" ? (JSON.parse(p) as AnonymousSurveySessionPayload) : (p as unknown as AnonymousSurveySessionPayload);
  return {
    ...payload,
    guildId: row.guild_id,
    executorUserId: row.executor_user_id,
  };
}

export async function consumeAnonymousSurveySession(
  db: Kysely<Database>,
  sessionId: string,
  userId: string,
): Promise<AnonymousSurveySessionPayload & { guildId: string; executorUserId: string | null } | null> {
  const nowIso = iso(new Date());
  const row = await db
    .deleteFrom("interaction_sessions")
    .where("id", "=", sessionId)
    .where("domain", "=", "anonymousSurvey")
    .where("action", "=", "slashGate")
    .where("executor_user_id", "=", userId)
    .where("expires_at", ">", nowIso as unknown as Date)
    .returning(["payload", "guild_id", "executor_user_id"])
    .executeTakeFirst();
  if (!row) return null;
  return parseAnonymousSurveySessionRow(row);
}

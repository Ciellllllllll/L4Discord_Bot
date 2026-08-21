import type { Kysely, Transaction } from "kysely";
import { randomUUID } from "node:crypto";
import { createSession, getSession } from "../../core/interactionSessions.js";
import type { Database } from "../../core/db/types.js";
import type { StoredSlashCommand } from "./surveyCommandState.js";

export const SKIP_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

export type AnonymousSurveyAction = "answer" | "skip";
type SurveyDb = Kysely<Database> | Transaction<Database>;

export type AnonymousSurveySessionPayload = {
  command: StoredSlashCommand;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseStoredOption(value: unknown, depth: number): StoredSlashCommand["options"][number] | null {
  if (!isRecord(value) || depth > 10 || typeof value.name !== "string" || !value.name || typeof value.type !== "number" || !Number.isInteger(value.type)) return null;
  if (value.value !== undefined && typeof value.value !== "string" && typeof value.value !== "number" && typeof value.value !== "boolean") return null;
  let user: StoredSlashCommand["options"][number]["user"];
  if (value.user !== undefined) {
    if (!isRecord(value.user) || typeof value.user.id !== "string" || typeof value.user.username !== "string" || typeof value.user.tag !== "string") return null;
    user = { id: value.user.id, username: value.user.username, tag: value.user.tag };
  }
  let options: StoredSlashCommand["options"] | undefined;
  if (value.options !== undefined) {
    if (!Array.isArray(value.options)) return null;
    options = [];
    for (const child of value.options) {
      const parsed = parseStoredOption(child, depth + 1);
      if (!parsed) return null;
      options.push(parsed);
    }
  }
  return {
    name: value.name,
    type: value.type,
    ...(value.value !== undefined ? { value: value.value as string | number | boolean } : {}),
    ...(user ? { user } : {}),
    ...(options ? { options } : {}),
  };
}

export function parseAnonymousSurveySessionPayload(raw: unknown): AnonymousSurveySessionPayload | null {
  let value = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw) as unknown; } catch { return null; }
  }
  if (!isRecord(value) || !isRecord(value.command)) return null;
  const command = value.command;
  if (typeof command.commandName !== "string" || !command.commandName || typeof command.guildId !== "string" || !command.guildId || typeof command.channelId !== "string" || !command.channelId || typeof command.userId !== "string" || !command.userId || !Array.isArray(command.options)) return null;
  const options: StoredSlashCommand["options"] = [];
  for (const option of command.options) {
    const parsed = parseStoredOption(option, 0);
    if (!parsed) return null;
    options.push(parsed);
  }
  return { command: { commandName: command.commandName, guildId: command.guildId, channelId: command.channelId, userId: command.userId, options } };
}

async function deleteAnonymousSurveySession(db: Kysely<Database>, sessionId: string): Promise<void> {
  await db
    .deleteFrom("interaction_sessions")
    .where("id", "=", sessionId)
    .where("domain", "=", "anonymousSurvey")
    .where("action", "=", "slashGate")
    .execute();
}

function payloadMatchesSession(
  payload: AnonymousSurveySessionPayload,
  guildId: string,
  executorUserId: string | null,
): boolean {
  return payload.command.guildId === guildId && (!executorUserId || payload.command.userId === executorUserId);
}

function iso(date: Date): string {
  return date.toISOString();
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
        id: randomUUID(),
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
  const id = randomUUID();
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
  let session: Awaited<ReturnType<typeof getSession>>;
  try {
    session = await getSession(db, sessionId);
  } catch {
    await deleteAnonymousSurveySession(db, sessionId).catch(() => undefined);
    return null;
  }
  if (!session || session.domain !== "anonymousSurvey" || session.action !== "slashGate") return null;
  const payload = parseAnonymousSurveySessionPayload(session.payload);
  if (!payload || !payloadMatchesSession(payload, session.guild_id, session.executor_user_id)) {
    await deleteAnonymousSurveySession(db, sessionId).catch(() => undefined);
    return null;
  }
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
): AnonymousSurveySessionPayload & { guildId: string; executorUserId: string | null } | null {
  const payload = parseAnonymousSurveySessionPayload(row.payload);
  if (!payload || !payloadMatchesSession(payload, row.guild_id, row.executor_user_id)) return null;
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

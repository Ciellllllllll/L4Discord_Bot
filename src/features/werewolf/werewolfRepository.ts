import type { Kysely } from "kysely";
import { nowIso } from "../../core/db/nowIso.js";
import type { Database } from "../../core/db/types.js";
import { parseWerewolfState, type WerewolfState } from "./werewolfState.js";

export type WerewolfGameRow = {
  id: string;
  guild_id: string;
  channel_id: string;
  host_id: string;
  phase: string;
  state: unknown;
};

export type LoadedWerewolfGame = {
  row: WerewolfGameRow;
  state: WerewolfState;
};

function normalizeLoadedRow(row: WerewolfGameRow | undefined): LoadedWerewolfGame | null {
  if (!row) return null;
  const state = parseWerewolfState(row.state);
  if (!state) return null;
  return { row, state };
}

export async function insertWerewolfGame(
  db: Kysely<Database>,
  input: { id: string; guildId: string; channelId: string; hostId: string; state: WerewolfState },
): Promise<void> {
  const now = nowIso() as unknown as Date;
  await db
    .insertInto("werewolf_games")
    .values({
      id: input.id,
      guild_id: input.guildId,
      channel_id: input.channelId,
      host_id: input.hostId,
      phase: input.state.phase,
      state: JSON.stringify(input.state) as unknown as Record<string, unknown>,
      created_at: now,
      updated_at: now,
    })
    .execute();
}

export async function findOpenWerewolfGameForChannel(
  db: Kysely<Database>,
  guildId: string,
  channelId: string,
): Promise<LoadedWerewolfGame | null> {
  const row = await db
    .selectFrom("werewolf_games")
    .select(["id", "guild_id", "channel_id", "host_id", "phase", "state"])
    .where("guild_id", "=", guildId)
    .where("channel_id", "=", channelId)
    .where("phase", "!=", "ended")
    .executeTakeFirst();
  return normalizeLoadedRow(row);
}

export async function findWerewolfGameById(
  db: Kysely<Database>,
  sessionId: string,
): Promise<LoadedWerewolfGame | null> {
  const row = await db
    .selectFrom("werewolf_games")
    .select(["id", "guild_id", "channel_id", "host_id", "phase", "state"])
    .where("id", "=", sessionId)
    .executeTakeFirst();
  return normalizeLoadedRow(row);
}

export async function listActiveWerewolfGames(db: Kysely<Database>): Promise<LoadedWerewolfGame[]> {
  const rows = await db
    .selectFrom("werewolf_games")
    .select(["id", "guild_id", "channel_id", "host_id", "phase", "state"])
    .where("phase", "!=", "ended")
    .execute();
  const out: LoadedWerewolfGame[] = [];
  for (const row of rows) {
    const loaded = normalizeLoadedRow(row);
    if (loaded) out.push(loaded);
  }
  return out;
}

export async function saveWerewolfState(
  db: Kysely<Database>,
  sessionId: string,
  state: WerewolfState,
): Promise<void> {
  await db
    .updateTable("werewolf_games")
    .set({
      phase: state.phase,
      state: JSON.stringify(state) as unknown as Record<string, unknown>,
      updated_at: nowIso() as unknown as Date,
    })
    .where("id", "=", sessionId)
    .execute();
}

export async function markWerewolfEnded(
  db: Kysely<Database>,
  sessionId: string,
  state: WerewolfState,
): Promise<void> {
  await saveWerewolfState(db, sessionId, { ...state, phase: "ended", deadlineAt: null });
}

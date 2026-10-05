import type { PgQueryable } from "../../core/db/postgres.js";
import type { BokeruOdai } from "./bokeruOdai.js";

export const BOKERU_VOTE_POINTS = 10;

export async function ensurePostgresBokeruSchema(pool: PgQueryable): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bokeru_rounds (
      id text PRIMARY KEY,
      guild_id text NOT NULL,
      channel_id text NOT NULL,
      message_id text,
      odai_id text NOT NULL,
      odai jsonb NOT NULL,
      status text NOT NULL CHECK (status IN ('open', 'closed')),
      closes_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_bokeru_rounds_open_guild ON bokeru_rounds (guild_id) WHERE status = 'open';
    CREATE INDEX IF NOT EXISTS idx_bokeru_rounds_open_closes ON bokeru_rounds (closes_at) WHERE status = 'open';

    CREATE TABLE IF NOT EXISTS bokeru_answers (
      id text PRIMARY KEY,
      round_id text NOT NULL REFERENCES bokeru_rounds (id) ON DELETE CASCADE,
      guild_id text NOT NULL,
      user_id text NOT NULL,
      text text NOT NULL,
      ai_score integer CHECK (ai_score BETWEEN 0 AND 100),
      ai_comment text,
      message_id text,
      final_score integer,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (round_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_bokeru_answers_guild_final ON bokeru_answers (guild_id) WHERE final_score IS NOT NULL;

    CREATE TABLE IF NOT EXISTS bokeru_votes (
      answer_id text NOT NULL REFERENCES bokeru_answers (id) ON DELETE CASCADE,
      user_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (answer_id, user_id)
    );
  `);
}

export type BokeruRound = {
  id: string;
  guild_id: string;
  channel_id: string;
  message_id: string | null;
  odai: BokeruOdai;
  status: "open" | "closed";
  closes_at: Date;
};

export type BokeruAnswer = {
  id: string;
  round_id: string;
  user_id: string;
  text: string;
  ai_score: number | null;
  ai_comment: string | null;
};

export type BokeruAnswerWithRound = BokeruAnswer & {
  round_status: "open" | "closed";
  closes_at: Date;
  votes: number;
};

export type BokeruResult = BokeruAnswer & { final_score: number };

const OPEN_ROUND = "status = 'open' AND closes_at > now()";

export async function countBokeruOdaiUsage(pool: PgQueryable, guildId: string): Promise<Map<string, number>> {
  const { rows } = await pool.query<{ odai_id: string; n: number }>(
    "SELECT odai_id, count(*)::int AS n FROM bokeru_rounds WHERE guild_id = $1 GROUP BY odai_id",
    [guildId],
  );
  return new Map(rows.map((r) => [r.odai_id, r.n]));
}

// 同じギルドで進行中のお題があれば false（部分ユニークインデックスで保証）。
export async function createBokeruRound(pool: PgQueryable, round: {
  id: string;
  guildId: string;
  channelId: string;
  odai: BokeruOdai;
  closesAt: Date;
}): Promise<boolean> {
  try {
    await pool.query(
      `INSERT INTO bokeru_rounds (id, guild_id, channel_id, odai_id, odai, status, closes_at)
       VALUES ($1, $2, $3, $4, $5, 'open', $6)`,
      [round.id, round.guildId, round.channelId, round.odai.id, JSON.stringify(round.odai), round.closesAt],
    );
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "23505") return false;
    throw error;
  }
}

export async function setBokeruRoundMessage(pool: PgQueryable, roundId: string, messageId: string): Promise<void> {
  await pool.query("UPDATE bokeru_rounds SET message_id = $2 WHERE id = $1", [roundId, messageId]);
}

export async function getBokeruRound(pool: PgQueryable, roundId: string): Promise<BokeruRound | null> {
  const { rows } = await pool.query<BokeruRound>(
    "SELECT id, guild_id, channel_id, message_id, odai, status, closes_at FROM bokeru_rounds WHERE id = $1",
    [roundId],
  );
  return rows[0] ?? null;
}

export function isBokeruRoundOpen(round: { status: string; closes_at: Date }, now = new Date()): boolean {
  return round.status === "open" && round.closes_at.getTime() > now.getTime();
}

export async function hasBokeruAnswer(pool: PgQueryable, roundId: string, userId: string): Promise<boolean> {
  const { rowCount } = await pool.query("SELECT 1 FROM bokeru_answers WHERE round_id = $1 AND user_id = $2", [roundId, userId]);
  return (rowCount ?? 0) > 0;
}

// 締切済み・回答済みなら false。
export async function insertBokeruAnswer(pool: PgQueryable, answer: {
  id: string;
  roundId: string;
  userId: string;
  text: string;
}): Promise<boolean> {
  const { rowCount } = await pool.query(
    `INSERT INTO bokeru_answers (id, round_id, guild_id, user_id, text)
     SELECT $1, r.id, r.guild_id, $3, $4 FROM bokeru_rounds r WHERE r.id = $2 AND r.${OPEN_ROUND}
     ON CONFLICT (round_id, user_id) DO NOTHING`,
    [answer.id, answer.roundId, answer.userId, answer.text],
  );
  return (rowCount ?? 0) > 0;
}

export async function setBokeruAnswerJudgement(
  pool: PgQueryable,
  answerId: string,
  judgement: { score: number; comment: string } | null,
): Promise<void> {
  await pool.query(
    "UPDATE bokeru_answers SET ai_score = $2, ai_comment = $3 WHERE id = $1",
    [answerId, judgement?.score ?? null, judgement?.comment ?? null],
  );
}

export async function setBokeruAnswerMessage(pool: PgQueryable, answerId: string, messageId: string): Promise<void> {
  await pool.query("UPDATE bokeru_answers SET message_id = $2 WHERE id = $1", [answerId, messageId]);
}

export async function getBokeruAnswer(pool: PgQueryable, answerId: string): Promise<BokeruAnswerWithRound | null> {
  const { rows } = await pool.query<BokeruAnswerWithRound>(
    `SELECT a.id, a.round_id, a.user_id, a.text, a.ai_score, a.ai_comment,
            r.status AS round_status, r.closes_at,
            (SELECT count(*)::int FROM bokeru_votes v WHERE v.answer_id = a.id) AS votes
     FROM bokeru_answers a JOIN bokeru_rounds r ON r.id = a.round_id WHERE a.id = $1`,
    [answerId],
  );
  return rows[0] ?? null;
}

// 投票済みなら取り消し、未投票なら投票する。締切後・自分の回答は何もせず null。
export async function toggleBokeruVote(pool: PgQueryable, answerId: string, userId: string): Promise<{ voted: boolean; votes: number } | null> {
  const votable = `EXISTS (
    SELECT 1 FROM bokeru_answers a JOIN bokeru_rounds r ON r.id = a.round_id
    WHERE a.id = $1 AND a.user_id <> $2 AND r.${OPEN_ROUND}
  )`;
  const removed = await pool.query(`DELETE FROM bokeru_votes WHERE answer_id = $1 AND user_id = $2 AND ${votable}`, [answerId, userId]);
  let voted = false;
  if ((removed.rowCount ?? 0) === 0) {
    const added = await pool.query(
      `INSERT INTO bokeru_votes (answer_id, user_id) SELECT $1, $2 WHERE ${votable} ON CONFLICT DO NOTHING`,
      [answerId, userId],
    );
    if ((added.rowCount ?? 0) === 0) return null;
    voted = true;
  }
  const { rows } = await pool.query<{ votes: number }>("SELECT count(*)::int AS votes FROM bokeru_votes WHERE answer_id = $1", [answerId]);
  return { voted, votes: rows[0]?.votes ?? 0 };
}

export async function listDueBokeruRoundIds(pool: PgQueryable): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM bokeru_rounds WHERE status = 'open' AND closes_at <= now()");
  return rows.map((r) => r.id);
}

// お題を締め切り、最終点（AI点 + 👍数 × 10）を確定する。既に締切済みなら null。
// 1文で更新するので、同時に呼ばれても結果を返すのは1回だけ。
export async function closeBokeruRound(pool: PgQueryable, roundId: string): Promise<BokeruResult[] | null> {
  const { rows } = await pool.query<{ round_id: string } & Partial<BokeruResult>>(
    `WITH closed AS (
       UPDATE bokeru_rounds SET status = 'closed' WHERE id = $1 AND status = 'open' RETURNING id
     ), scored AS (
       UPDATE bokeru_answers a
       SET final_score = COALESCE(a.ai_score, 0) + $2 * (SELECT count(*) FROM bokeru_votes v WHERE v.answer_id = a.id)
       FROM closed WHERE a.round_id = closed.id
       RETURNING a.id, a.round_id, a.user_id, a.text, a.ai_score, a.ai_comment, a.final_score
     )
     SELECT c.id AS round_id, s.id, s.user_id, s.text, s.ai_score, s.ai_comment, s.final_score
     FROM closed c LEFT JOIN scored s ON true`,
    [roundId, BOKERU_VOTE_POINTS],
  );
  if (rows.length === 0) return null;
  return rows
    .filter((r): r is typeof r & BokeruResult => r.id != null)
    .sort((a, b) => b.final_score - a.final_score);
}

export async function getBokeruUserRanking(pool: PgQueryable, guildId: string, limit = 10): Promise<Array<{ user_id: string; total: number; answers: number }>> {
  const { rows } = await pool.query<{ user_id: string; total: number; answers: number }>(
    `SELECT user_id, sum(final_score)::int AS total, count(*)::int AS answers
     FROM bokeru_answers WHERE guild_id = $1 AND final_score IS NOT NULL
     GROUP BY user_id ORDER BY total DESC, answers ASC LIMIT $2`,
    [guildId, limit],
  );
  return rows;
}

export async function getBokeruBestAnswers(pool: PgQueryable, guildId: string, limit = 5): Promise<Array<{ user_id: string; text: string; final_score: number }>> {
  const { rows } = await pool.query<{ user_id: string; text: string; final_score: number }>(
    `SELECT user_id, text, final_score FROM bokeru_answers
     WHERE guild_id = $1 AND final_score IS NOT NULL
     ORDER BY final_score DESC, created_at ASC LIMIT $2`,
    [guildId, limit],
  );
  return rows;
}

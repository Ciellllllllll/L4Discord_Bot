import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type pino from "pino";
import type { PgQueryable } from "../core/db/postgres.js";

const CHECKPOINT_INTERVAL_MS = 5_000;

export type RuntimeUptimeController = {
  getUptimeSeconds(): number;
  stop(): Promise<void>;
};

type RuntimeUptimeOptions = {
  pool: Pool;
  runtimeKey: string;
  botVersion: string;
  log?: Pick<pino.Logger, "warn">;
  now?: () => number;
  setInterval?: (callback: () => void, delay: number) => NodeJS.Timeout;
  clearInterval?: (timer: NodeJS.Timeout) => void;
  createSessionId?: () => string;
};

export async function ensurePostgresRuntimeUptimeSchema(pool: PgQueryable): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_runtime_sessions (
      session_id text PRIMARY KEY,
      runtime_key text NOT NULL,
      bot_version text NOT NULL,
      started_at timestamptz NOT NULL,
      last_checkpoint_at timestamptz NOT NULL,
      active_seconds bigint NOT NULL DEFAULT 0 CHECK (active_seconds >= 0),
      ended_at timestamptz,
      end_reason text,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (
        (ended_at IS NULL AND end_reason IS NULL)
        OR (ended_at IS NOT NULL AND end_reason IN ('graceful', 'interrupted'))
      )
    );
    CREATE INDEX IF NOT EXISTS idx_bot_runtime_sessions_key_end
      ON bot_runtime_sessions (runtime_key, ended_at);
  `);
}

export async function startRuntimeUptime(options: RuntimeUptimeOptions): Promise<RuntimeUptimeController> {
  const now = options.now ?? Date.now;
  const sessionId = options.createSessionId?.() ?? randomUUID();
  const startedAtMs = now();
  const totalBeforeSeconds = await openRuntimeSession(
    options.pool,
    sessionId,
    options.runtimeKey,
    options.botVersion,
    new Date(startedAtMs),
  );

  let committedSeconds = totalBeforeSeconds;
  let lastCheckpointAtMs = startedAtMs;
  let stopped = false;
  let stopPromise: Promise<void> | undefined;
  let queue = Promise.resolve();
  const setTimer = options.setInterval ?? ((callback, delay) => setInterval(callback, delay));
  const clearTimer = options.clearInterval ?? clearInterval;

  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const next = queue.then(operation, operation);
    queue = next.catch(() => undefined);
    return next;
  };

  const checkpoint = async (finish: boolean): Promise<void> => {
    if (stopped) return;
    const checkpointAtMs = lastCheckpointAtMs + Math.max(0, Math.floor((now() - lastCheckpointAtMs) / 1_000)) * 1_000;
    const deltaSeconds = Math.floor((checkpointAtMs - lastCheckpointAtMs) / 1_000);
    const client = await options.pool.connect();
    try {
      const result = finish
        ? await client.query(
          `UPDATE bot_runtime_sessions
           SET active_seconds = active_seconds + $2,
               last_checkpoint_at = $3,
               ended_at = $3,
               end_reason = 'graceful'
           WHERE session_id = $1 AND ended_at IS NULL`,
          [sessionId, deltaSeconds, new Date(checkpointAtMs)],
        )
        : await client.query(
          `UPDATE bot_runtime_sessions
           SET active_seconds = active_seconds + $2,
               last_checkpoint_at = $3
           WHERE session_id = $1 AND ended_at IS NULL`,
          [sessionId, deltaSeconds, new Date(checkpointAtMs)],
        );
      if (result.rowCount !== 1) throw new Error(`runtime uptime session ${sessionId} was not active`);
      committedSeconds += deltaSeconds;
      lastCheckpointAtMs = checkpointAtMs;
      if (finish) stopped = true;
    } finally {
      client.release();
    }
  };

  const tick = () => {
    void enqueue(() => checkpoint(false)).catch((err) => {
      options.log?.warn({ err }, "runtime uptime checkpoint failed");
    });
  };
  const timer = setTimer(tick, CHECKPOINT_INTERVAL_MS);

  return {
    getUptimeSeconds: () => committedSeconds + Math.floor(Math.max(0, now() - lastCheckpointAtMs) / 1_000),
    stop: () => stopPromise ??= (async () => {
      clearTimer(timer);
      await enqueue(() => checkpoint(true));
    })(),
  };
}

async function openRuntimeSession(
  pool: Pool,
  sessionId: string,
  runtimeKey: string,
  botVersion: string,
  startedAt: Date,
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT session_id, last_checkpoint_at
       FROM bot_runtime_sessions
       WHERE runtime_key = $1 AND ended_at IS NULL
       FOR UPDATE`,
      [runtimeKey],
    );
    await client.query(
      `UPDATE bot_runtime_sessions
       SET ended_at = last_checkpoint_at,
           end_reason = 'interrupted'
       WHERE runtime_key = $1 AND ended_at IS NULL`,
      [runtimeKey],
    );
    const total = await client.query<{ total_seconds: string | number }>(
      `SELECT COALESCE(SUM(active_seconds), 0)::bigint AS total_seconds
       FROM bot_runtime_sessions
       WHERE runtime_key = $1`,
      [runtimeKey],
    );
    await client.query(
      `INSERT INTO bot_runtime_sessions (
        session_id, runtime_key, bot_version, started_at, last_checkpoint_at
      ) VALUES ($1, $2, $3, $4, $4)`,
      [sessionId, runtimeKey, botVersion, startedAt],
    );
    await client.query("COMMIT");
    return parseSeconds(total.rows[0]?.total_seconds ?? 0);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function parseSeconds(value: string | number): number {
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw new Error(`invalid runtime uptime seconds: ${String(value)}`);
  return seconds;
}

import type DatabaseLib from "better-sqlite3";
import type { Pool } from "pg";
import type { PgQueryable } from "../../core/db/postgres.js";
import type { BotContext } from "../../bot/context.js";
import { sqliteTimestamp } from "../../core/db/sqliteTimestamp.js";
import type {
  LolWatcherAccount,
  LolWatcherActiveGame,
  LolWatcherActiveStatus,
  LolWatcherNotificationStatus,
  LolWatcherNotificationType,
  LolWatcherStatus,
} from "./lolWatcher.types.js";

type AccountRow = {
  account_key: string;
  account_key_norm: string;
  user_id: string | null;
  channel_id: string | null;
  enabled: boolean | number | string;
  created_at: string;
  updated_at: string;
};

type ActiveGameRow = {
  account_key_norm: string;
  game_id: string;
  message_id: string | null;
  status: LolWatcherActiveStatus;
  started_at: string | null;
  last_seen_at: string;
  missing_since: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

type StatusRow = {
  key: string;
  value: string | null;
  updated_at: string;
};

export function ensureLolWatcherSchema(db: DatabaseLib.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lol_watcher_accounts (
      account_key TEXT NOT NULL,
      account_key_norm TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lol_watcher_active_games (
      account_key_norm TEXT NOT NULL,
      game_id TEXT NOT NULL,
      message_id TEXT,
      status TEXT NOT NULL,
      started_at TEXT,
      last_seen_at TEXT NOT NULL,
      missing_since TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(account_key_norm, game_id)
    );

    CREATE TABLE IF NOT EXISTS lol_watcher_notifications (
      account_key_norm TEXT NOT NULL,
      game_id TEXT NOT NULL,
      message_id TEXT,
      notification_type TEXT NOT NULL,
      status TEXT NOT NULL,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(account_key_norm, game_id)
    );

    CREATE TABLE IF NOT EXISTS lol_watcher_status (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_lol_watcher_accounts_enabled
      ON lol_watcher_accounts (enabled, account_key_norm);

    CREATE INDEX IF NOT EXISTS idx_lol_watcher_active_games_status
      ON lol_watcher_active_games (status, account_key_norm);
  `);
  ensureColumn(db, "lol_watcher_accounts", "user_id", "TEXT");
  ensureColumn(db, "lol_watcher_accounts", "channel_id", "TEXT");
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lol_watcher_accounts_user_id_unique
      ON lol_watcher_accounts (user_id)
      WHERE user_id IS NOT NULL;
  `);
}

function ensureColumn(db: DatabaseLib.Database, table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!rows.some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function toAccount(row: AccountRow): LolWatcherAccount {
  return {
    accountKey: row.account_key,
    accountKeyNorm: row.account_key_norm,
    userId: row.user_id,
    channelId: row.channel_id,
    enabled: row.enabled === true || row.enabled === 1 || row.enabled === "1" || row.enabled === "t",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toActiveGame(row: ActiveGameRow): LolWatcherActiveGame {
  return {
    accountKeyNorm: row.account_key_norm,
    gameId: row.game_id,
    messageId: row.message_id,
    status: row.status,
    startedAt: row.started_at,
    lastSeenAt: row.last_seen_at,
    missingSince: row.missing_since,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class LolWatcherRepository {
  constructor(private readonly db: DatabaseLib.Database) {}

  async ensureSchema(): Promise<void> {
    ensureLolWatcherSchema(this.db);
  }

  async setStatus(key: string, value: string | null): Promise<void> {
    this.db
      .prepare(
        `
        INSERT INTO lol_watcher_status (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `,
      )
      .run(key, value, sqliteTimestamp());
  }

  async listStatus(): Promise<LolWatcherStatus[]> {
    return this.db
      .prepare<[], StatusRow>("SELECT key, value, updated_at FROM lol_watcher_status ORDER BY key")
      .all()
      .map((row) => ({ key: row.key, value: row.value, updatedAt: row.updated_at }));
  }

  async getStatus(key: string): Promise<LolWatcherStatus | null> {
    const row = this.db
      .prepare<[string], StatusRow>("SELECT key, value, updated_at FROM lol_watcher_status WHERE key = ?")
      .get(key);
    return row ? { key: row.key, value: row.value, updatedAt: row.updated_at } : null;
  }

  async getNotificationChannelId(): Promise<string | null> {
    return (await this.getStatus("notification_channel_id"))?.value ?? null;
  }

  async setNotificationChannelId(channelId: string): Promise<{ changed: boolean; channelId: string }> {
    const current = await this.getNotificationChannelId();
    if (current === channelId) return { changed: false, channelId };
    await this.setStatus("notification_channel_id", channelId);
    return { changed: true, channelId };
  }

  async upsertAccount(accountKey: string, accountKeyNorm: string): Promise<{ created: boolean; account: LolWatcherAccount }> {
    const now = sqliteTimestamp();
    const existing = await this.getAccount(accountKeyNorm);
    this.db
      .prepare(
        `
        INSERT INTO lol_watcher_accounts (account_key, account_key_norm, enabled, created_at, updated_at)
        VALUES (?, ?, 1, ?, ?)
        ON CONFLICT(account_key_norm) DO UPDATE SET
          account_key = excluded.account_key,
          enabled = 1,
          updated_at = excluded.updated_at
      `,
      )
      .run(accountKey, accountKeyNorm, now, now);
    const account = await this.getAccount(accountKeyNorm);
    if (!account) throw new Error("LoL watcher account not found after upsert");
    return { created: !existing, account };
  }

  async upsertUserAccount(
    userId: string,
    accountKey: string,
    accountKeyNorm: string,
  ): Promise<{ ok: true; created: boolean; account: LolWatcherAccount } | { ok: false; reason: "already_registered" | "duplicate_account"; account: LolWatcherAccount }> {
    const existingForAccount = await this.getAccount(accountKeyNorm);
    if (existingForAccount && existingForAccount.userId !== userId) {
      return { ok: false, reason: "duplicate_account", account: existingForAccount };
    }

    const now = sqliteTimestamp();
    const existingForUser = await this.getAccountByUserId(userId);
    if (existingForUser) {
      if (existingForUser.enabled && existingForUser.accountKeyNorm !== accountKeyNorm) {
        return { ok: false, reason: "already_registered", account: existingForUser };
      }
      this.db
        .prepare(
          `
          UPDATE lol_watcher_accounts
          SET account_key = ?,
              account_key_norm = ?,
              enabled = 1,
              updated_at = ?
          WHERE user_id = ?
        `,
        )
        .run(accountKey, accountKeyNorm, now, userId);
      const account = await this.getAccountByUserId(userId);
      if (!account) throw new Error("LoL watcher user account not found after update");
      return { ok: true, created: false, account };
    }

    this.db
      .prepare(
        `
        INSERT INTO lol_watcher_accounts (account_key, account_key_norm, user_id, enabled, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?)
      `,
      )
      .run(accountKey, accountKeyNorm, userId, now, now);
    const account = await this.getAccountByUserId(userId);
    if (!account) throw new Error("LoL watcher user account not found after insert");
    return { ok: true, created: true, account };
  }

  async disableAccount(accountKeyNorm: string): Promise<number> {
    const result = this.db
      .prepare("UPDATE lol_watcher_accounts SET enabled = 0, updated_at = ? WHERE account_key_norm = ?")
      .run(sqliteTimestamp(), accountKeyNorm);
    return result.changes;
  }

  async disableAccountForUser(userId: string): Promise<LolWatcherAccount | null> {
    const account = await this.getAccountByUserId(userId);
    if (!account || !account.enabled) return null;
    this.db
      .prepare("UPDATE lol_watcher_accounts SET enabled = 0, updated_at = ? WHERE user_id = ?")
      .run(sqliteTimestamp(), userId);
    return account;
  }

  async getAccount(accountKeyNorm: string): Promise<LolWatcherAccount | null> {
    const row = this.db
      .prepare<[string], AccountRow>(
        "SELECT account_key, account_key_norm, user_id, channel_id, enabled, created_at, updated_at FROM lol_watcher_accounts WHERE account_key_norm = ?",
      )
      .get(accountKeyNorm);
    return row ? toAccount(row) : null;
  }

  async getAccountByUserId(userId: string): Promise<LolWatcherAccount | null> {
    const row = this.db
      .prepare<[string], AccountRow>(
        "SELECT account_key, account_key_norm, user_id, channel_id, enabled, created_at, updated_at FROM lol_watcher_accounts WHERE user_id = ?",
      )
      .get(userId);
    return row ? toAccount(row) : null;
  }

  async listAccounts(includeDisabled = false): Promise<LolWatcherAccount[]> {
    const sql = includeDisabled
      ? "SELECT account_key, account_key_norm, user_id, channel_id, enabled, created_at, updated_at FROM lol_watcher_accounts ORDER BY updated_at DESC"
      : "SELECT account_key, account_key_norm, user_id, channel_id, enabled, created_at, updated_at FROM lol_watcher_accounts WHERE enabled = 1 ORDER BY updated_at DESC";
    return this.db.prepare<[], AccountRow>(sql).all().map(toAccount);
  }

  async getActiveGame(accountKeyNorm: string, gameId: string): Promise<LolWatcherActiveGame | null> {
    const row = this.db
      .prepare<[string, string], ActiveGameRow>(
        `
        SELECT account_key_norm, game_id, message_id, status, started_at, last_seen_at,
               missing_since, error_message, created_at, updated_at
        FROM lol_watcher_active_games
        WHERE account_key_norm = ? AND game_id = ?
      `,
      )
      .get(accountKeyNorm, gameId);
    return row ? toActiveGame(row) : null;
  }

  async listOpenActiveGames(accountKeyNorm: string): Promise<LolWatcherActiveGame[]> {
    return this.db
      .prepare<[string], ActiveGameRow>(
        `
        SELECT account_key_norm, game_id, message_id, status, started_at, last_seen_at,
               missing_since, error_message, created_at, updated_at
        FROM lol_watcher_active_games
        WHERE account_key_norm = ? AND status IN ('active', 'missing', 'stale', 'error')
      `,
      )
      .all(accountKeyNorm)
      .map(toActiveGame);
  }

  async upsertActiveGame(input: {
    accountKeyNorm: string;
    gameId: string;
    messageId: string | null;
    startedAt: string | null;
    status: LolWatcherActiveStatus;
    errorMessage?: string | null;
  }): Promise<void> {
    const now = sqliteTimestamp();
    this.db
      .prepare(
        `
        INSERT INTO lol_watcher_active_games (
          account_key_norm, game_id, message_id, status, started_at, last_seen_at,
          missing_since, error_message, created_at, updated_at
        )
        VALUES (@accountKeyNorm, @gameId, @messageId, @status, @startedAt, @now, NULL, @errorMessage, @now, @now)
        ON CONFLICT(account_key_norm, game_id) DO UPDATE SET
          message_id = COALESCE(excluded.message_id, message_id),
          status = excluded.status,
          started_at = COALESCE(excluded.started_at, started_at),
          last_seen_at = excluded.last_seen_at,
          missing_since = NULL,
          error_message = excluded.error_message,
          updated_at = excluded.updated_at
      `,
      )
      .run({ ...input, errorMessage: input.errorMessage ?? null, now });
  }

  async markActiveSeen(accountKeyNorm: string, gameId: string): Promise<void> {
    const now = sqliteTimestamp();
    this.db
      .prepare(
        `
        UPDATE lol_watcher_active_games
        SET status = 'active', last_seen_at = ?, missing_since = NULL, error_message = NULL, updated_at = ?
        WHERE account_key_norm = ? AND game_id = ?
      `,
      )
      .run(now, now, accountKeyNorm, gameId);
  }

  async markMissing(game: LolWatcherActiveGame): Promise<void> {
    const now = sqliteTimestamp();
    this.db
      .prepare(
        `
        UPDATE lol_watcher_active_games
        SET status = 'missing',
            missing_since = COALESCE(missing_since, ?),
            updated_at = ?
        WHERE account_key_norm = ? AND game_id = ? AND status != 'stale'
      `,
      )
      .run(now, now, game.accountKeyNorm, game.gameId);
  }

  async markStale(game: LolWatcherActiveGame): Promise<void> {
    const now = sqliteTimestamp();
    this.db
      .prepare(
        `
        UPDATE lol_watcher_active_games
        SET status = 'stale', updated_at = ?
        WHERE account_key_norm = ? AND game_id = ?
      `,
      )
      .run(now, game.accountKeyNorm, game.gameId);
  }

  async markCompleted(accountKeyNorm: string, gameId: string): Promise<void> {
    const now = sqliteTimestamp();
    this.db
      .prepare(
        `
        UPDATE lol_watcher_active_games
        SET status = 'completed', missing_since = NULL, error_message = NULL, updated_at = ?
        WHERE account_key_norm = ? AND game_id = ?
      `,
      )
      .run(now, accountKeyNorm, gameId);
  }

  async hasNotification(accountKeyNorm: string, gameId: string): Promise<boolean> {
    const row = this.db
      .prepare<[string, string], { one: number }>(
        "SELECT 1 AS one FROM lol_watcher_notifications WHERE account_key_norm = ? AND game_id = ?",
      )
      .get(accountKeyNorm, gameId);
    return !!row;
  }

  async saveNotification(input: {
    accountKeyNorm: string;
    gameId: string;
    messageId: string | null;
    notificationType: LolWatcherNotificationType;
    status: LolWatcherNotificationStatus;
    errorMessage?: string | null;
  }): Promise<void> {
    const now = sqliteTimestamp();
    this.db
      .prepare(
        `
        INSERT INTO lol_watcher_notifications (
          account_key_norm, game_id, message_id, notification_type, status,
          error_message, created_at, updated_at
        )
        VALUES (
          @accountKeyNorm, @gameId, @messageId, @notificationType, @status,
          @errorMessage, @now, @now
        )
        ON CONFLICT(account_key_norm, game_id) DO UPDATE SET
          message_id = COALESCE(excluded.message_id, message_id),
          notification_type = excluded.notification_type,
          status = excluded.status,
          error_message = excluded.error_message,
          updated_at = excluded.updated_at
      `,
      )
      .run({ ...input, errorMessage: input.errorMessage ?? null, now });
  }
}

export type LolWatcherRepositoryLike = LolWatcherRepository | PostgresLolWatcherRepository;

export function createLolWatcherRepository(ctx: BotContext): LolWatcherRepositoryLike {
  if (ctx.gameDealPgPool) return new PostgresLolWatcherRepository(ctx.gameDealPgPool);
  if (!ctx.sqlite) throw new Error("LoL watcher SQLite repository is unavailable");
  return new LolWatcherRepository(ctx.sqlite);
}

export async function ensurePostgresLolWatcherSchema(pool: PgQueryable): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lol_watcher_accounts (
      account_key text NOT NULL,
      account_key_norm text NOT NULL UNIQUE,
      user_id text UNIQUE,
      channel_id text,
      enabled boolean NOT NULL DEFAULT true,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lol_watcher_active_games (
      account_key_norm text NOT NULL,
      game_id text NOT NULL,
      message_id text,
      status text NOT NULL,
      started_at text,
      last_seen_at text NOT NULL,
      missing_since text,
      error_message text,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      UNIQUE (account_key_norm, game_id)
    );
    CREATE TABLE IF NOT EXISTS lol_watcher_notifications (
      account_key_norm text NOT NULL,
      game_id text NOT NULL,
      message_id text,
      notification_type text NOT NULL,
      status text NOT NULL,
      error_message text,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      UNIQUE (account_key_norm, game_id)
    );
    CREATE TABLE IF NOT EXISTS lol_watcher_status (
      key text PRIMARY KEY,
      value text,
      updated_at text NOT NULL
    );
    CREATE INDEX IF NOT EXISTS lol_watcher_accounts_enabled_idx ON lol_watcher_accounts (enabled, account_key_norm);
    CREATE INDEX IF NOT EXISTS lol_watcher_active_games_status_idx ON lol_watcher_active_games (status, account_key_norm);
  `);
}

export class PostgresLolWatcherRepository {
  constructor(private readonly pool: Pool) {}

  async ensureSchema(): Promise<void> { await ensurePostgresLolWatcherSchema(this.pool); }

  async setStatus(key: string, value: string | null): Promise<void> {
    await this.pool.query(
      `INSERT INTO lol_watcher_status (key, value, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, sqliteTimestamp()],
    );
  }

  async listStatus(): Promise<LolWatcherStatus[]> {
    const result = await this.pool.query<StatusRow>("SELECT key, value, updated_at FROM lol_watcher_status ORDER BY key");
    return result.rows.map((row) => ({ key: row.key, value: row.value, updatedAt: row.updated_at }));
  }

  async getStatus(key: string): Promise<LolWatcherStatus | null> {
    const result = await this.pool.query<StatusRow>("SELECT key, value, updated_at FROM lol_watcher_status WHERE key = $1", [key]);
    const row = result.rows[0];
    return row ? { key: row.key, value: row.value, updatedAt: row.updated_at } : null;
  }

  async getNotificationChannelId(): Promise<string | null> { return (await this.getStatus("notification_channel_id"))?.value ?? null; }

  async setNotificationChannelId(channelId: string): Promise<{ changed: boolean; channelId: string }> {
    if ((await this.getNotificationChannelId()) === channelId) return { changed: false, channelId };
    await this.setStatus("notification_channel_id", channelId);
    return { changed: true, channelId };
  }

  private async getAccountBy(column: "account_key_norm" | "user_id", value: string): Promise<LolWatcherAccount | null> {
    const result = await this.pool.query<AccountRow>(
      `SELECT account_key, account_key_norm, user_id, channel_id, enabled, created_at, updated_at FROM lol_watcher_accounts WHERE ${column} = $1`,
      [value],
    );
    const row = result.rows[0];
    return row ? toAccount(row) : null;
  }

  async getAccount(accountKeyNorm: string): Promise<LolWatcherAccount | null> { return this.getAccountBy("account_key_norm", accountKeyNorm); }
  async getAccountByUserId(userId: string): Promise<LolWatcherAccount | null> { return this.getAccountBy("user_id", userId); }

  async upsertAccount(accountKey: string, accountKeyNorm: string): Promise<{ created: boolean; account: LolWatcherAccount }> {
    const existing = await this.getAccount(accountKeyNorm);
    const now = sqliteTimestamp();
    await this.pool.query(
      `INSERT INTO lol_watcher_accounts (account_key, account_key_norm, enabled, created_at, updated_at)
       VALUES ($1, $2, true, $3, $3)
       ON CONFLICT(account_key_norm) DO UPDATE SET account_key = excluded.account_key, enabled = true, updated_at = excluded.updated_at`,
      [accountKey, accountKeyNorm, now],
    );
    const account = await this.getAccount(accountKeyNorm);
    if (!account) throw new Error("LoL watcher account was not returned after upsert");
    return { created: !existing, account };
  }

  async upsertUserAccount(userId: string, accountKey: string, accountKeyNorm: string): Promise<{ ok: true; created: boolean; account: LolWatcherAccount } | { ok: false; reason: "already_registered" | "duplicate_account"; account: LolWatcherAccount }> {
    const existingForAccount = await this.getAccount(accountKeyNorm);
    if (existingForAccount && existingForAccount.userId !== userId) return { ok: false, reason: "duplicate_account", account: existingForAccount };
    const existingForUser = await this.getAccountByUserId(userId);
    const now = sqliteTimestamp();
    if (existingForUser) {
      if (existingForUser.enabled && existingForUser.accountKeyNorm !== accountKeyNorm) return { ok: false, reason: "already_registered", account: existingForUser };
      await this.pool.query("UPDATE lol_watcher_accounts SET account_key = $1, account_key_norm = $2, enabled = true, updated_at = $3 WHERE user_id = $4", [accountKey, accountKeyNorm, now, userId]);
      const account = await this.getAccountByUserId(userId);
      if (!account) throw new Error("LoL watcher user account was not returned after update");
      return { ok: true, created: false, account };
    }
    await this.pool.query("INSERT INTO lol_watcher_accounts (account_key, account_key_norm, user_id, enabled, created_at, updated_at) VALUES ($1, $2, $3, true, $4, $4)", [accountKey, accountKeyNorm, userId, now]);
    const account = await this.getAccountByUserId(userId);
    if (!account) throw new Error("LoL watcher user account was not returned after insert");
    return { ok: true, created: true, account };
  }

  async disableAccount(accountKeyNorm: string): Promise<number> {
    const result = await this.pool.query("UPDATE lol_watcher_accounts SET enabled = false, updated_at = $1 WHERE account_key_norm = $2", [sqliteTimestamp(), accountKeyNorm]);
    return result.rowCount ?? 0;
  }

  async disableAccountForUser(userId: string): Promise<LolWatcherAccount | null> {
    const account = await this.getAccountByUserId(userId);
    if (!account || !account.enabled) return null;
    await this.pool.query("UPDATE lol_watcher_accounts SET enabled = false, updated_at = $1 WHERE user_id = $2", [sqliteTimestamp(), userId]);
    return account;
  }

  async listAccounts(includeDisabled = false): Promise<LolWatcherAccount[]> {
    const result = await this.pool.query<AccountRow>(`SELECT account_key, account_key_norm, user_id, channel_id, enabled, created_at, updated_at FROM lol_watcher_accounts ${includeDisabled ? "" : "WHERE enabled = true"} ORDER BY updated_at DESC`);
    return result.rows.map(toAccount);
  }

  async getActiveGame(accountKeyNorm: string, gameId: string): Promise<LolWatcherActiveGame | null> {
    const result = await this.pool.query<ActiveGameRow>("SELECT account_key_norm, game_id, message_id, status, started_at, last_seen_at, missing_since, error_message, created_at, updated_at FROM lol_watcher_active_games WHERE account_key_norm = $1 AND game_id = $2", [accountKeyNorm, gameId]);
    return result.rows[0] ? toActiveGame(result.rows[0]) : null;
  }

  async listOpenActiveGames(accountKeyNorm: string): Promise<LolWatcherActiveGame[]> {
    const result = await this.pool.query<ActiveGameRow>("SELECT account_key_norm, game_id, message_id, status, started_at, last_seen_at, missing_since, error_message, created_at, updated_at FROM lol_watcher_active_games WHERE account_key_norm = $1 AND status IN ('active', 'missing', 'stale', 'error')", [accountKeyNorm]);
    return result.rows.map(toActiveGame);
  }

  async upsertActiveGame(input: { accountKeyNorm: string; gameId: string; messageId: string | null; startedAt: string | null; status: LolWatcherActiveStatus; errorMessage?: string | null }): Promise<void> {
    const now = sqliteTimestamp();
    await this.pool.query(`INSERT INTO lol_watcher_active_games (account_key_norm, game_id, message_id, status, started_at, last_seen_at, missing_since, error_message, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $6, $6) ON CONFLICT(account_key_norm, game_id) DO UPDATE SET message_id = COALESCE(excluded.message_id, lol_watcher_active_games.message_id), status = excluded.status, started_at = COALESCE(excluded.started_at, lol_watcher_active_games.started_at), last_seen_at = excluded.last_seen_at, missing_since = NULL, error_message = excluded.error_message, updated_at = excluded.updated_at`, [input.accountKeyNorm, input.gameId, input.messageId, input.status, input.startedAt, now, input.errorMessage ?? null]);
  }

  async markActiveSeen(accountKeyNorm: string, gameId: string): Promise<void> { await this.pool.query("UPDATE lol_watcher_active_games SET status = 'active', last_seen_at = $1, missing_since = NULL, error_message = NULL, updated_at = $1 WHERE account_key_norm = $2 AND game_id = $3", [sqliteTimestamp(), accountKeyNorm, gameId]); }
  async markMissing(game: LolWatcherActiveGame): Promise<void> { const now = sqliteTimestamp(); await this.pool.query("UPDATE lol_watcher_active_games SET status = 'missing', missing_since = COALESCE(missing_since, $1), updated_at = $1 WHERE account_key_norm = $2 AND game_id = $3 AND status != 'stale'", [now, game.accountKeyNorm, game.gameId]); }
  async markStale(game: LolWatcherActiveGame): Promise<void> { await this.pool.query("UPDATE lol_watcher_active_games SET status = 'stale', updated_at = $1 WHERE account_key_norm = $2 AND game_id = $3", [sqliteTimestamp(), game.accountKeyNorm, game.gameId]); }
  async markCompleted(accountKeyNorm: string, gameId: string): Promise<void> { await this.pool.query("UPDATE lol_watcher_active_games SET status = 'completed', missing_since = NULL, error_message = NULL, updated_at = $1 WHERE account_key_norm = $2 AND game_id = $3", [sqliteTimestamp(), accountKeyNorm, gameId]); }
  async hasNotification(accountKeyNorm: string, gameId: string): Promise<boolean> { const result = await this.pool.query("SELECT 1 FROM lol_watcher_notifications WHERE account_key_norm = $1 AND game_id = $2", [accountKeyNorm, gameId]); return (result.rowCount ?? 0) > 0; }
  async saveNotification(input: { accountKeyNorm: string; gameId: string; messageId: string | null; notificationType: LolWatcherNotificationType; status: LolWatcherNotificationStatus; errorMessage?: string | null }): Promise<void> { const now = sqliteTimestamp(); await this.pool.query(`INSERT INTO lol_watcher_notifications (account_key_norm, game_id, message_id, notification_type, status, error_message, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $7) ON CONFLICT(account_key_norm, game_id) DO UPDATE SET message_id = COALESCE(excluded.message_id, lol_watcher_notifications.message_id), notification_type = excluded.notification_type, status = excluded.status, error_message = excluded.error_message, updated_at = excluded.updated_at`, [input.accountKeyNorm, input.gameId, input.messageId, input.notificationType, input.status, input.errorMessage ?? null, now]); }
}

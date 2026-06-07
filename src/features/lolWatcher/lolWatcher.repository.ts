import type DatabaseLib from "better-sqlite3";
import { sqliteTimestamp } from "../../core/db/sqliteTimestamp.js";
import type {
  LolWatcherAccount,
  LolWatcherActiveGame,
  LolWatcherActiveStatus,
  LolWatcherNotificationStatus,
  LolWatcherNotificationType,
  LolWatcherNotification,
  LolWatcherStatus,
} from "./lolWatcher.types.js";

type AccountRow = {
  account_key: string;
  account_key_norm: string;
  user_id: string | null;
  channel_id: string | null;
  enabled: number;
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

type NotificationRow = {
  account_key_norm: string;
  game_id: string;
  message_id: string | null;
  notification_type: LolWatcherNotificationType;
  status: LolWatcherNotificationStatus;
  error_message: string | null;
  deeplol_status: "pending" | "enriched" | "not_found" | "failed";
  deeplol_retry_count: number;
  created_at: string;
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
  ensureColumn(db, "lol_watcher_notifications", "deeplol_status", "TEXT NOT NULL DEFAULT 'pending'");
  ensureColumn(db, "lol_watcher_notifications", "deeplol_retry_count", "INTEGER NOT NULL DEFAULT 0");
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
    enabled: row.enabled === 1,
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

function toNotification(row: NotificationRow): LolWatcherNotification {
  return {
    accountKeyNorm: row.account_key_norm,
    gameId: row.game_id,
    messageId: row.message_id,
    notificationType: row.notification_type,
    status: row.status,
    errorMessage: row.error_message,
    deepLolStatus: row.deeplol_status,
    deepLolRetryCount: row.deeplol_retry_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class LolWatcherRepository {
  constructor(private readonly db: DatabaseLib.Database) {}

  ensureSchema(): void {
    ensureLolWatcherSchema(this.db);
  }

  setStatus(key: string, value: string | null): void {
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

  listStatus(): LolWatcherStatus[] {
    return this.db
      .prepare<[], StatusRow>("SELECT key, value, updated_at FROM lol_watcher_status ORDER BY key")
      .all()
      .map((row) => ({ key: row.key, value: row.value, updatedAt: row.updated_at }));
  }

  getStatus(key: string): LolWatcherStatus | null {
    const row = this.db
      .prepare<[string], StatusRow>("SELECT key, value, updated_at FROM lol_watcher_status WHERE key = ?")
      .get(key);
    return row ? { key: row.key, value: row.value, updatedAt: row.updated_at } : null;
  }

  getNotificationChannelId(): string | null {
    return this.getStatus("notification_channel_id")?.value ?? null;
  }

  setNotificationChannelId(channelId: string): { changed: boolean; channelId: string } {
    const current = this.getNotificationChannelId();
    if (current === channelId) return { changed: false, channelId };
    this.setStatus("notification_channel_id", channelId);
    return { changed: true, channelId };
  }

  upsertAccount(accountKey: string, accountKeyNorm: string): { created: boolean; account: LolWatcherAccount } {
    const now = sqliteTimestamp();
    const existing = this.getAccount(accountKeyNorm);
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
    return { created: !existing, account: this.getAccount(accountKeyNorm)! };
  }

  upsertUserAccount(
    userId: string,
    accountKey: string,
    accountKeyNorm: string,
  ): { ok: true; created: boolean; account: LolWatcherAccount } | { ok: false; reason: "already_registered" | "duplicate_account"; account: LolWatcherAccount } {
    const existingForAccount = this.getAccount(accountKeyNorm);
    if (existingForAccount && existingForAccount.userId !== userId) {
      return { ok: false, reason: "duplicate_account", account: existingForAccount };
    }

    const now = sqliteTimestamp();
    const existingForUser = this.getAccountByUserId(userId);
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
      return { ok: true, created: false, account: this.getAccountByUserId(userId)! };
    }

    this.db
      .prepare(
        `
        INSERT INTO lol_watcher_accounts (account_key, account_key_norm, user_id, enabled, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?)
      `,
      )
      .run(accountKey, accountKeyNorm, userId, now, now);
    return { ok: true, created: true, account: this.getAccountByUserId(userId)! };
  }

  disableAccount(accountKeyNorm: string): number {
    const result = this.db
      .prepare("UPDATE lol_watcher_accounts SET enabled = 0, updated_at = ? WHERE account_key_norm = ?")
      .run(sqliteTimestamp(), accountKeyNorm);
    return result.changes;
  }

  disableAccountForUser(userId: string): LolWatcherAccount | null {
    const account = this.getAccountByUserId(userId);
    if (!account || !account.enabled) return null;
    this.db
      .prepare("UPDATE lol_watcher_accounts SET enabled = 0, updated_at = ? WHERE user_id = ?")
      .run(sqliteTimestamp(), userId);
    return account;
  }

  getAccount(accountKeyNorm: string): LolWatcherAccount | null {
    const row = this.db
      .prepare<[string], AccountRow>(
        "SELECT account_key, account_key_norm, user_id, channel_id, enabled, created_at, updated_at FROM lol_watcher_accounts WHERE account_key_norm = ?",
      )
      .get(accountKeyNorm);
    return row ? toAccount(row) : null;
  }

  getAccountByUserId(userId: string): LolWatcherAccount | null {
    const row = this.db
      .prepare<[string], AccountRow>(
        "SELECT account_key, account_key_norm, user_id, channel_id, enabled, created_at, updated_at FROM lol_watcher_accounts WHERE user_id = ?",
      )
      .get(userId);
    return row ? toAccount(row) : null;
  }

  listAccounts(includeDisabled = false): LolWatcherAccount[] {
    const sql = includeDisabled
      ? "SELECT account_key, account_key_norm, user_id, channel_id, enabled, created_at, updated_at FROM lol_watcher_accounts ORDER BY updated_at DESC"
      : "SELECT account_key, account_key_norm, user_id, channel_id, enabled, created_at, updated_at FROM lol_watcher_accounts WHERE enabled = 1 ORDER BY updated_at DESC";
    return this.db.prepare<[], AccountRow>(sql).all().map(toAccount);
  }

  getActiveGame(accountKeyNorm: string, gameId: string): LolWatcherActiveGame | null {
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

  listOpenActiveGames(accountKeyNorm: string): LolWatcherActiveGame[] {
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

  upsertActiveGame(input: {
    accountKeyNorm: string;
    gameId: string;
    messageId: string | null;
    startedAt: string | null;
    status: LolWatcherActiveStatus;
    errorMessage?: string | null;
  }): void {
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

  markActiveSeen(accountKeyNorm: string, gameId: string): void {
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

  markMissing(game: LolWatcherActiveGame): void {
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

  markStale(game: LolWatcherActiveGame): void {
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

  markCompleted(accountKeyNorm: string, gameId: string): void {
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

  hasNotification(accountKeyNorm: string, gameId: string): boolean {
    const row = this.db
      .prepare<[string, string], { one: number }>(
        "SELECT 1 AS one FROM lol_watcher_notifications WHERE account_key_norm = ? AND game_id = ?",
      )
      .get(accountKeyNorm, gameId);
    return !!row;
  }

  getNotification(accountKeyNorm: string, gameId: string): LolWatcherNotification | null {
    const row = this.db
      .prepare<[string, string], NotificationRow>(
        `
        SELECT account_key_norm, game_id, message_id, notification_type, status,
               error_message, deeplol_status, deeplol_retry_count, created_at, updated_at
        FROM lol_watcher_notifications
        WHERE account_key_norm = ? AND game_id = ?
      `,
      )
      .get(accountKeyNorm, gameId);
    return row ? toNotification(row) : null;
  }

  saveNotification(input: {
    accountKeyNorm: string;
    gameId: string;
    messageId: string | null;
    notificationType: LolWatcherNotificationType;
    status: LolWatcherNotificationStatus;
    errorMessage?: string | null;
  }): void {
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

  updateDeepLolStatus(input: {
    accountKeyNorm: string;
    gameId: string;
    status: "pending" | "enriched" | "not_found" | "failed";
    retryCount?: number;
    errorMessage?: string | null;
  }): void {
    const now = sqliteTimestamp();
    this.db
      .prepare(
        `
        UPDATE lol_watcher_notifications
        SET deeplol_status = @status,
            deeplol_retry_count = COALESCE(@retryCount, deeplol_retry_count),
            error_message = COALESCE(@errorMessage, error_message),
            updated_at = @now
        WHERE account_key_norm = @accountKeyNorm AND game_id = @gameId
      `,
      )
      .run({
        accountKeyNorm: input.accountKeyNorm,
        gameId: input.gameId,
        status: input.status,
        retryCount: input.retryCount ?? null,
        errorMessage: input.errorMessage ?? null,
        now,
      });
  }
}

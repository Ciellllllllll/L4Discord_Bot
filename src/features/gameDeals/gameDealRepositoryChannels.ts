import { nowIso } from "../../core/db/nowIso.js";
import type { Pool, PoolClient } from "pg";
import type {
  GameDealNotifyChannel,
  GameDealStatus,
} from "./gameDealTypes.js";
import { type ChannelRow, type StatusRow, toChannel } from "./gameDealRepositoryShared.js";

// ゲームセール通知の通知先チャンネルとスキャン状態。

export class GameDealRepositoryChannels {
  constructor(readonly pool: Pool) {}

  protected async withConflictKeyLock<T>(
    namespace: number,
    key: string,
    run: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [namespace, key]);
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Ignore rollback failures and rethrow the original error.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async getNotifyChannel(guildId: string): Promise<GameDealNotifyChannel | null> {
    const result = await this.pool.query<ChannelRow>(
      "SELECT guild_id, channel_id, enabled FROM game_deal_notify_channels WHERE guild_id = $1",
      [guildId],
    );
    return result.rows[0] ? toChannel(result.rows[0]) : null;
  }

  async listEnabledNotifyChannels(): Promise<GameDealNotifyChannel[]> {
    const result = await this.pool.query<ChannelRow>(
      "SELECT guild_id, channel_id, enabled FROM game_deal_notify_channels WHERE enabled = true",
    );
    return result.rows.map(toChannel);
  }

  async enableNotifyChannel(guildId: string, channelId: string): Promise<{ alreadyEnabledInChannel: boolean }> {
    const now = nowIso();
    const existing = await this.getNotifyChannel(guildId);
    if (existing?.enabled && existing.channelId === channelId) return { alreadyEnabledInChannel: true };
    await this.pool.query(
      `
      INSERT INTO game_deal_notify_channels (guild_id, channel_id, enabled, created_at, updated_at)
      VALUES ($1, $2, true, $3, $3)
      ON CONFLICT (guild_id) DO UPDATE SET
        channel_id = excluded.channel_id,
        enabled = true,
        updated_at = excluded.updated_at
    `,
      [guildId, channelId, now],
    );
    return { alreadyEnabledInChannel: false };
  }

  async disableNotifyChannel(guildId: string): Promise<void> {
    await this.pool.query(
      "UPDATE game_deal_notify_channels SET enabled = false, updated_at = $1 WHERE guild_id = $2",
      [nowIso(), guildId],
    );
  }

  async getStatus(): Promise<GameDealStatus> {
    const result = await this.pool.query<StatusRow>(`
      SELECT last_scan_at, last_success_at, last_error, last_detected_count,
             last_steam_search_status, last_steam_search_error, steam_search_cooldown_until
      FROM game_deal_watcher_status
      WHERE id = 1
    `);
    const row = result.rows[0];
    return {
      lastScanAt: row?.last_scan_at ?? null,
      lastSuccessAt: row?.last_success_at ?? null,
      lastError: row?.last_error ?? null,
      lastDetectedCount: row?.last_detected_count ?? 0,
      lastSteamSearchStatus: row?.last_steam_search_status ?? null,
      lastSteamSearchError: row?.last_steam_search_error ?? null,
      steamSearchCooldownUntil: row?.steam_search_cooldown_until ?? null,
    };
  }

  async markScanStarted(now = nowIso()): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO game_deal_watcher_status (id, last_scan_at, last_detected_count)
      VALUES (1, $1, 0)
      ON CONFLICT (id) DO UPDATE SET last_scan_at = excluded.last_scan_at
    `,
      [now],
    );
  }

  async markScanSuccess(count: number, now = nowIso()): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO game_deal_watcher_status (id, last_scan_at, last_success_at, last_error, last_detected_count)
      VALUES (1, $1, $1, NULL, $2)
      ON CONFLICT (id) DO UPDATE SET
        last_scan_at = excluded.last_scan_at,
        last_success_at = excluded.last_success_at,
        last_error = NULL,
        last_detected_count = excluded.last_detected_count
    `,
      [now, count],
    );
  }

  async markScanError(error: string, now = nowIso()): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO game_deal_watcher_status (id, last_scan_at, last_error, last_detected_count)
      VALUES (1, $1, $2, 0)
      ON CONFLICT (id) DO UPDATE SET
        last_scan_at = excluded.last_scan_at,
        last_error = excluded.last_error
    `,
      [now, error.slice(0, 1000)],
    );
  }

  async getSteamSearchCooldownUntil(): Promise<string | null> {
    const result = await this.pool.query<{ steam_search_cooldown_until: string | null }>(
      "SELECT steam_search_cooldown_until FROM game_deal_watcher_status WHERE id = 1",
    );
    return result.rows[0]?.steam_search_cooldown_until ?? null;
  }

  async updateSteamSearchStatus(input: { status: string; error: string | null; cooldownUntil: string | null }): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO game_deal_watcher_status
        (id, last_detected_count, last_steam_search_status, last_steam_search_error, steam_search_cooldown_until)
      VALUES (1, 0, $1, $2, $3)
      ON CONFLICT (id) DO UPDATE SET
        last_steam_search_status = excluded.last_steam_search_status,
        last_steam_search_error = excluded.last_steam_search_error,
        steam_search_cooldown_until = excluded.steam_search_cooldown_until
    `,
      [input.status, input.error?.slice(0, 1000) ?? null, input.cooldownUntil],
    );
  }
}

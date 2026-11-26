import { nowIso } from "../../core/db/nowIso.js";
import type { GameDealPlatform, SteamFreeEvent } from "./gameDealTypes.js";
import {
  FREE_SEEN_LOCK_NAMESPACE,
  STEAM_FREE_EVENT_LOCK_NAMESPACE,
  clampLimit,
  toSteamFreeEvent,
  type SteamFreeEventRow,
} from "./gameDealRepositoryShared.js";
import { GameDealRepositorySubscriptions } from "./gameDealRepositorySubscriptions.js";

// ゲームセール通知の無料配布検出と Steam イベント。

export class GameDealRepositorySteamFree extends GameDealRepositorySubscriptions {
  async upsertFreeSeen(
    input: { platform: GameDealPlatform; title: string; dedupeKey: string },
    markNotified: boolean,
  ): Promise<{ shouldNotify: boolean }> {
    return this.withConflictKeyLock(FREE_SEEN_LOCK_NAMESPACE, input.dedupeKey, async (client) => {
      const now = nowIso();
      const existing = await client.query<{ notified_at: string | null }>(
        "SELECT notified_at FROM game_deal_detected_items WHERE dedupe_key = $1",
        [input.dedupeKey],
      );
      const row = existing.rows[0];
      const shouldNotify = markNotified && (!row || !row.notified_at);

      if (!row) {
        await client.query(
          `
          INSERT INTO game_deal_detected_items
            (platform, title, dedupe_key, first_detected_at, last_seen_at, notified_at, active)
          VALUES ($1, $2, $3, $4, $4, $5, true)
        `,
          [input.platform, input.title, input.dedupeKey, now, shouldNotify ? now : null],
        );
        return { shouldNotify };
      }

      await client.query(
        `
        UPDATE game_deal_detected_items
        SET title = $1,
            last_seen_at = $2,
            notified_at = CASE WHEN $3 THEN $2 ELSE notified_at END,
            active = true
        WHERE dedupe_key = $4
      `,
        [input.title, now, shouldNotify, input.dedupeKey],
      );
      return { shouldNotify };
    });
  }

  async markFreeNotified(dedupeKey: string): Promise<void> {
    await this.pool.query("UPDATE game_deal_detected_items SET notified_at = $1 WHERE dedupe_key = $2", [
      nowIso(),
      dedupeKey,
    ]);
  }

  async upsertSteamFreeEvent(input: SteamFreeEvent): Promise<{ shouldNotify: boolean }> {
    return this.withConflictKeyLock(STEAM_FREE_EVENT_LOCK_NAMESPACE, input.stateKey, async (client) => {
      const now = nowIso();
      const existing = await client.query<{ notified_at: string | null }>(
        "SELECT notified_at FROM steam_free_events WHERE state_key = $1",
        [input.stateKey],
      );
      const row = existing.rows[0];
      const shouldNotify = !row || !row.notified_at;

      if (!row) {
        await client.query(
          `
          INSERT INTO steam_free_events (
            appid, title, state_key, price_change_number, last_modified, normal_price_cents,
            current_price_cents, discount_percent, evidence_json, steam_url, image_url,
            first_detected_at, last_seen_at, notified_at, active
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12, NULL, true)
        `,
          [
            input.appid,
            input.title,
            input.stateKey,
            input.priceChangeNumber,
            input.lastModified,
            input.normalPriceCents,
            input.currentPriceCents,
            input.discountPercent,
            input.evidenceJson,
            input.steamUrl,
            input.imageUrl,
            now,
          ],
        );
        return { shouldNotify };
      }

      await client.query(
        `
        UPDATE steam_free_events
        SET title = $1,
            last_seen_at = $2,
            evidence_json = $3,
            active = true
        WHERE state_key = $4
      `,
        [input.title, now, input.evidenceJson, input.stateKey],
      );
      return { shouldNotify };
    });
  }

  async markSteamFreeEventNotified(stateKey: string): Promise<void> {
    await this.pool.query("UPDATE steam_free_events SET notified_at = $1 WHERE state_key = $2", [nowIso(), stateKey]);
  }

  async listActiveSteamFreeEvents(limit = 20): Promise<SteamFreeEvent[]> {
    const safeLimit = clampLimit(limit);
    const result = await this.pool.query<SteamFreeEventRow>(`
      SELECT appid, title, state_key, price_change_number, last_modified, normal_price_cents,
             current_price_cents, discount_percent, evidence_json, steam_url, image_url
      FROM steam_free_events
      WHERE active = true
      ORDER BY last_seen_at DESC
      LIMIT ${safeLimit}
    `);
    return result.rows.map(toSteamFreeEvent);
  }
}

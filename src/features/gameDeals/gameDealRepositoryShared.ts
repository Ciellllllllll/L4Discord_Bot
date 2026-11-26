import type {
  GameDealNotifyChannel,
  GameDealPlatform,
  GameDealSubscription,
  SteamFreeEvent,
} from "./gameDealTypes.js";

// ゲームセール通知リポジトリの行型とマッピング。

export type ChannelRow = {
  guild_id: string;
  channel_id: string;
  enabled: boolean;
};

export type StatusRow = {
  last_scan_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  last_detected_count: number;
  last_steam_search_status: string | null;
  last_steam_search_error: string | null;
  steam_search_cooldown_until: string | null;
};

export type SubRow = {
  id: string;
  guild_id: string;
  channel_id: string;
  user_id: string;
  platform: GameDealPlatform;
  target_id: string;
  url: string;
  title: string | null;
  last_state_key: string | null;
  active: boolean;
};

export type NotificationRow = {
  subscription_id: string;
  user_id: string;
  action_pressed: string | null;
  guild_id: string | null;
  target_platform: GameDealPlatform | null;
  target_id: string | null;
};

export type SteamFreeEventRow = {
  appid: string;
  title: string;
  state_key: string;
  price_change_number: number | null;
  last_modified: number | null;
  normal_price_cents: number | null;
  current_price_cents: number;
  discount_percent: number | null;
  evidence_json: string;
  steam_url: string;
  image_url: string | null;
};

export const FREE_SEEN_LOCK_NAMESPACE = 4101;
export const STEAM_FREE_EVENT_LOCK_NAMESPACE = 4103;

export function toChannel(row: ChannelRow): GameDealNotifyChannel {
  return { guildId: row.guild_id, channelId: row.channel_id, enabled: row.enabled };
}

export function toSub(row: SubRow): GameDealSubscription {
  return {
    id: row.id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    userId: row.user_id,
    platform: row.platform,
    targetId: row.target_id,
    url: row.url,
    title: row.title,
    lastStateKey: row.last_state_key,
    active: row.active,
  };
}

export function toSteamFreeEvent(row: SteamFreeEventRow): SteamFreeEvent {
  return {
    appid: row.appid,
    title: row.title,
    stateKey: row.state_key,
    priceChangeNumber: row.price_change_number,
    lastModified: row.last_modified,
    normalPriceCents: row.normal_price_cents,
    currentPriceCents: row.current_price_cents,
    discountPercent: row.discount_percent,
    evidenceJson: row.evidence_json,
    steamUrl: row.steam_url,
    imageUrl: row.image_url,
  };
}

export function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 1;
  return Math.max(1, Math.min(100, Math.trunc(limit)));
}

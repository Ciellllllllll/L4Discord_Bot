import type { ActionRowBuilder, ButtonBuilder, EmbedBuilder } from "discord.js";

export type GameDealPlatform = "steam" | "epic";

export type GameDealNotifyChannel = {
  guildId: string;
  channelId: string;
  enabled: boolean;
};

export type GameDealStatus = {
  lastScanAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastDetectedCount: number;
  lastSteamSearchStatus: string | null;
  lastSteamSearchError: string | null;
  steamSearchCooldownUntil: string | null;
  cheapSharkCooldownUntil?: string | null;
};

export type GameDealFreeItem = {
  platform: GameDealPlatform;
  title: string;
  dedupeKey: string;
  embed: EmbedBuilder;
  components?: ActionRowBuilder<ButtonBuilder>[];
};

export type GameDealSubscription = {
  id: string;
  guildId: string;
  channelId: string;
  userId: string;
  platform: GameDealPlatform;
  targetId: string;
  url: string;
  title: string | null;
  lastStateKey: string | null;
  active: boolean;
};

export type GameDealSubscriptionHit = {
  subscription: GameDealSubscription;
  title: string;
  url: string;
  imageUrl: string | null;
  originalPrice: number | null;
  currentPrice: number | null;
  discountPercent: number | null;
  stateKey: string;
  platform: GameDealPlatform;
};

export type GameDealSourceStatus = {
  platform: GameDealPlatform;
  status: "ok" | "unavailable" | "cooldown" | "failed";
  message?: string;
  cooldownUntil?: string;
};

export type GameDealScanResult = {
  items: GameDealFreeItem[];
  sources: GameDealSourceStatus[];
};

export type DealWatchItem = {
  id: number;
  guildId: string;
  channelId: string | null;
  steamAppId: string;
  title: string | null;
  lastDealId: string | null;
  lastSalePrice: number | null;
  lastNormalPrice: number | null;
  lastSavings: number | null;
  lastChange: number | null;
  lastCheckedAt: string | null;
  lastNotifiedAt: string | null;
  enabled: boolean;
};

import type { ActionRowBuilder, ButtonBuilder } from "discord.js";
import type { ComponentCardBuilder } from "../panels/componentCard.js";

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
};

export type GameDealFreeItem = {
  platform: GameDealPlatform;
  title: string;
  dedupeKey: string;
  embed: ComponentCardBuilder;
  components?: ActionRowBuilder<ButtonBuilder>[];
};

export type SteamFreeEvent = {
  appid: string;
  title: string;
  stateKey: string;
  priceChangeNumber: number | null;
  lastModified: number | null;
  normalPriceCents: number | null;
  currentPriceCents: number;
  discountPercent: number | null;
  evidenceJson: string;
  steamUrl: string;
  imageUrl: string | null;
  freeUntilUnix?: number | null;
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

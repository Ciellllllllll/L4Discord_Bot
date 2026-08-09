import type { BotContext } from "../../bot/context.js";
import { SteamStoreClient } from "../steam/steamStoreClient.js";
import type { SteamAppDetails, SteamSearchItem } from "../steam/steamFreeTypes.js";
import { buildSteamFreeEventEmbed } from "./gameDealEmbeds.js";
import { createGameDealRepository } from "./postgresGameDealRepository.js";
import type { GameDealFreeItem, SteamFreeEvent } from "./gameDealTypes.js";

const DEFAULT_STEAM_NOW_LIMIT = 20;
const STEAM_NOW_DETAILS_BATCH_SIZE = 10;
const EXCLUDED_TYPE_WORDS = ["dlc", "demo", "soundtrack", "software", "tool", "video", "hardware"];
const FREE_PLAY_TEXT = /free\s*weekend|play\s*for\s*free|無料プレイ|週末無料|フリーウィークエンド/i;
const F2P_TEXT = /free\s*to\s*play|基本プレイ無料|無料プレイ可/i;

type SteamNowScanOptions = {
  onlyUnnotified?: boolean;
  signal?: AbortSignal;
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Game deal watcher stopped", "AbortError");
}

function toFreeItem(event: SteamFreeEvent): GameDealFreeItem {
  return {
    platform: "steam",
    title: event.title,
    dedupeKey: event.stateKey,
    embed: buildSteamFreeEventEmbed(event),
  };
}

function searchItemIsFullDiscount(item: SteamSearchItem): boolean {
  return (
    typeof item.originalPrice === "number" &&
    item.originalPrice > 0 &&
    item.finalPrice === 0 &&
    (item.discountPercent ?? 0) >= 100
  );
}

function normalizedWords(details: SteamAppDetails | null): string[] {
  return [
    details?.type,
    ...(details?.categories ?? []),
    ...(details?.genres ?? []),
  ]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());
}

function textIncludesAny(values: Array<string | undefined>, matcher: RegExp): boolean {
  return values.some((value) => !!value && matcher.test(value));
}

function steamNowExclusionReason(item: SteamSearchItem, details: SteamAppDetails | null): string | null {
  if (!searchItemIsFullDiscount(item)) return "not_full_discount";
  if (!details) return "missing_appdetails";
  if (details.type?.toLowerCase() !== "game") return "excluded_non_game_type";
  if (normalizedWords(details).some((word) => EXCLUDED_TYPE_WORDS.some((excluded) => word.includes(excluded)))) {
    return "excluded_non_game_content";
  }
  // Steamの`is_free`は期間限定の無料配布でもtrueになるため、常設F2P判定には単独で使わない。
  const priceOverview = details.priceOverview;
  const hasTemporaryFreeLicense = details.isFree === true
    && priceOverview?.final === priceOverview?.initial
    && typeof priceOverview?.finalFormatted === "string"
    && /無料|free/i.test(priceOverview?.finalFormatted ?? "");
  if (
    !priceOverview
    || typeof priceOverview.initial !== "number"
    || priceOverview.initial <= 0
    || typeof priceOverview.final !== "number"
    || (priceOverview.final !== 0 && !hasTemporaryFreeLicense)
    || (typeof priceOverview.discountPercent === "number" && priceOverview.discountPercent < 100)
  ) {
    return "not_currently_free_in_appdetails";
  }

  const textValues = [
    details.name,
    details.shortDescription,
    item.name,
    item.rawPriceText,
    ...(details.categories ?? []),
    ...(details.genres ?? []),
  ];
  if (textIncludesAny(textValues, FREE_PLAY_TEXT)) return "excluded_free_weekend_or_play_free";
  if (textIncludesAny(textValues, F2P_TEXT)) return "excluded_free_to_play";
  return null;
}

function steamNowEvent(item: SteamSearchItem, details: SteamAppDetails): SteamFreeEvent {
  const po = details.priceOverview;
  const normalPriceCents = typeof po?.initial === "number" && po.initial > 0
    ? po.initial
    : Math.round(item.originalPrice! * 100);
  return {
    appid: item.appid,
    title: details.name || item.name,
    stateKey: `steam_now:${item.appid}:${item.discountPercent ?? 100}:${normalPriceCents}`,
    priceChangeNumber: null,
    lastModified: null,
    normalPriceCents,
    currentPriceCents: 0,
    discountPercent: 100,
    evidenceJson: JSON.stringify([{ source: "steam_search", normalPriceCents, currentPriceCents: 0, discountPercent: 100 }]),
    steamUrl: item.storeUrl || `https://store.steampowered.com/app/${item.appid}/`,
    imageUrl: details.headerImage ?? details.capsuleImage ?? null,
    freeUntilUnix: details.priceOverview?.discountExpiration ?? null,
  };
}

export async function scanSteamNowFullDiscountItems(
  ctx: BotContext,
  limit = DEFAULT_STEAM_NOW_LIMIT,
  options: SteamNowScanOptions = {},
): Promise<GameDealFreeItem[]> {
  const repo = createGameDealRepository(ctx);
  const store = new SteamStoreClient(ctx.log);
  const searchItems = (await store.fetchSearchItems(undefined, { signal: options.signal })).filter(searchItemIsFullDiscount);
  if (searchItems.length === 0) return [];

  const items: GameDealFreeItem[] = [];
  const excludedReasons: Record<string, number> = {};

  for (let offset = 0; offset < searchItems.length && items.length < limit; offset += STEAM_NOW_DETAILS_BATCH_SIZE) {
    throwIfAborted(options.signal);
    const batch = searchItems.slice(offset, offset + STEAM_NOW_DETAILS_BATCH_SIZE);
    const detailsByAppid = await store.fetchAppDetails(batch.map((item) => item.appid), { signal: options.signal });
    for (const searchItem of batch) {
      throwIfAborted(options.signal);
      const details = detailsByAppid.get(searchItem.appid) ?? null;
      const exclusionReason = steamNowExclusionReason(searchItem, details);
      if (exclusionReason) {
        excludedReasons[exclusionReason] = (excludedReasons[exclusionReason] ?? 0) + 1;
        ctx.log.debug(
          { appid: searchItem.appid, title: searchItem.name, reason: exclusionReason },
          "steam now full discount candidate excluded",
        );
        continue;
      }
      const event = steamNowEvent(searchItem, details!);
      const result = await repo.upsertSteamFreeEvent(event);
      if (!options.onlyUnnotified || result.shouldNotify) {
        items.push(toFreeItem(event));
      }
      if (items.length >= limit) break;
    }
  }

  ctx.log.info(
    { searchCandidates: searchItems.length, itemCount: items.length, excludedReasons },
    "steam now full discount scan completed",
  );
  return items;
}

export async function listActiveSteamFreeItems(ctx: BotContext, limit = 20): Promise<GameDealFreeItem[]> {
  const repo = createGameDealRepository(ctx);
  return (await repo.listActiveSteamFreeEvents(limit)).map(toFreeItem);
}

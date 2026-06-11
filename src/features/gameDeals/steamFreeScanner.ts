import type { BotContext } from "../../bot/context.js";
import { SteamAppListClient, SteamAppListHttpError } from "../steam/steamAppListClient.js";
import { SteamStoreClient } from "../steam/steamStoreClient.js";
import type { SteamAppDetails, SteamSearchItem } from "../steam/steamFreeTypes.js";
import { CheapSharkClient } from "./cheapSharkClient.js";
import { buildSteamFreeEventEmbed, buildSteamLinkButtons } from "./gameDealEmbeds.js";
import { GameDealRepository } from "./gameDealRepository.js";
import type { GameDealFreeItem, SteamAppCatalogChange, SteamFreeEvent } from "./gameDealTypes.js";
import { detectSteamFreeEvent } from "./steamFreeDetector.js";

export const DEFAULT_STEAM_VERIFY_BATCH_SIZE = 20;

type SteamScanSummary = {
  appListCount: number;
  diffCount: number;
  queuedCount: number;
  verifiedCount: number;
  excludedCount: number;
  notifiedCandidates: number;
  excludedReasons: Record<string, number>;
};

function steamApiKey(ctx: BotContext): string | undefined {
  const value = "STEAM_WEB_API_KEY" in ctx.config ? (ctx.config as { STEAM_WEB_API_KEY?: string }).STEAM_WEB_API_KEY : undefined;
  return value?.trim() || undefined;
}

function toFreeItem(event: SteamFreeEvent): GameDealFreeItem {
  return {
    platform: "steam",
    title: event.title,
    dedupeKey: event.stateKey,
    embed: buildSteamFreeEventEmbed(event),
    components: [buildSteamLinkButtons(event)],
  };
}

function centsDisplay(cents: number | null | undefined): string | null {
  if (typeof cents !== "number") return null;
  return `${Math.round(cents / 100).toLocaleString("ja-JP")}円`;
}

function upsertPaidEvidence(repo: GameDealRepository, appid: string, title: string, details: SteamAppDetails | null, searchItem: SteamSearchItem | null): void {
  const po = details?.priceOverview;
  if (po && typeof po.initial === "number" && po.initial > 0) {
    repo.upsertSteamPaidPriceHistory({
      appid,
      title: details?.name ?? title,
      normalPriceCents: po.initial,
      normalPriceDisplay: po.initialFormatted ?? centsDisplay(po.initial),
      source: "steam_appdetails",
    });
    return;
  }
  if (searchItem && typeof searchItem.originalPrice === "number" && searchItem.originalPrice > 0) {
    const cents = Math.round(searchItem.originalPrice * 100);
    repo.upsertSteamPaidPriceHistory({
      appid,
      title: searchItem.name || title,
      normalPriceCents: cents,
      normalPriceDisplay: centsDisplay(cents),
      source: "steam_search",
    });
  }
}

async function fetchCheapSharkDeals(ctx: BotContext, appid: string) {
  try {
    return await new CheapSharkClient(ctx.log).fetchSteamDealsByAppId(appid);
  } catch (err) {
    ctx.log.warn({ err, appid }, "cheapshark auxiliary verification failed");
    return [];
  }
}

async function verifyChanges(ctx: BotContext, changes: SteamAppCatalogChange[], searchByAppid: Map<string, SteamSearchItem>): Promise<{ items: GameDealFreeItem[]; summary: Pick<SteamScanSummary, "verifiedCount" | "excludedCount" | "notifiedCandidates" | "excludedReasons"> }> {
  const repo = new GameDealRepository(ctx.sqlite);
  const store = new SteamStoreClient(ctx.log);
  const detailsMap = await store.fetchAppDetails(changes.map((change) => change.appid));
  const items: GameDealFreeItem[] = [];
  let verifiedCount = 0;
  let excludedCount = 0;
  const excludedReasons: Record<string, number> = {};

  for (const change of changes) {
    const details = detailsMap.get(change.appid) ?? null;
    const searchItem = searchByAppid.get(change.appid) ?? null;
    if (!details) {
      repo.markSteamVerifyRetry(change.appid, "appdetails_failed", "appdetails unavailable");
      continue;
    }
    const title = details.name || searchItem?.name || change.name || `Steam ${change.appid}`;
    upsertPaidEvidence(repo, change.appid, title, details, searchItem);
    const cheapSharkDeals = await fetchCheapSharkDeals(ctx, change.appid);
    const cheapSharkPaid = cheapSharkDeals.find((deal) => deal.normalPrice > 0 && deal.salePrice === 0 && deal.savings >= 99.9);
    if (cheapSharkPaid) {
      repo.upsertSteamPaidPriceHistory({
        appid: change.appid,
        title: cheapSharkPaid.title,
        normalPriceCents: Math.round(cheapSharkPaid.normalPrice * 100),
        normalPriceDisplay: `$${cheapSharkPaid.normalPrice.toFixed(2)}`,
        source: "cheapshark",
      });
    }
    const paidHistory = repo.getSteamPaidPriceHistory(change.appid);
    const detected = detectSteamFreeEvent({ change, appdetails: details, searchItem, cheapSharkDeals, paidHistory });
    if (!detected.shouldNotify) {
      excludedCount += 1;
      excludedReasons[detected.reason] = (excludedReasons[detected.reason] ?? 0) + 1;
      repo.removeSteamVerifyQueue(change.appid);
      continue;
    }
    const event: SteamFreeEvent = {
      appid: detected.appid,
      title: detected.title,
      stateKey: detected.stateKey,
      priceChangeNumber: change.priceChangeNumber,
      lastModified: change.lastModified,
      normalPriceCents: detected.normalPriceCents,
      currentPriceCents: detected.currentPriceCents,
      discountPercent: detected.discountPercent,
      evidenceJson: JSON.stringify(detected.evidence),
      steamUrl: detected.steamUrl,
      imageUrl: detected.imageUrl,
    };
    verifiedCount += 1;
    repo.removeSteamVerifyQueue(change.appid);
    if (repo.upsertSteamFreeEvent(event).shouldNotify) {
      items.push(toFreeItem(event));
    }
  }

  return { items, summary: { verifiedCount, excludedCount, notifiedCandidates: items.length, excludedReasons } };
}

async function fetchSearchByAppid(ctx: BotContext): Promise<Map<string, SteamSearchItem>> {
  try {
    const items = await new SteamStoreClient(ctx.log).fetchSearchItems();
    return new Map(items.map((item) => [item.appid, item]));
  } catch (err) {
    ctx.log.warn({ err }, "steam search auxiliary verification failed");
    return new Map();
  }
}

export async function initializeSteamAppBaseline(ctx: BotContext): Promise<{ created: boolean; appCount: number }> {
  const repo = new GameDealRepository(ctx.sqlite);
  if (repo.hasSteamAppCatalog()) return { created: false, appCount: 0 };
  const apps = await new SteamAppListClient(ctx.log, steamApiKey(ctx)).fetchAllApps();
  const result = repo.upsertSteamAppCatalog(apps);
  ctx.log.info({ appCount: apps.length, baselineCreated: result.baselineCreated }, "steam app baseline initialized");
  return { created: result.baselineCreated, appCount: apps.length };
}

export async function scanSteamAppListChanges(ctx: BotContext): Promise<SteamScanSummary> {
  const repo = new GameDealRepository(ctx.sqlite);
  try {
    const apps = await new SteamAppListClient(ctx.log, steamApiKey(ctx)).fetchAllApps();
    const result = repo.upsertSteamAppCatalog(apps);
    for (const change of result.changes) {
      repo.enqueueSteamVerify({
        appid: change.appid,
        reason: "price_change_detected",
        priceChangeNumber: change.priceChangeNumber,
        lastModified: change.lastModified,
      });
    }
    ctx.log.info(
      { appListCount: apps.length, diffCount: result.changes.length, queuedCount: result.changes.length, baselineCreated: result.baselineCreated },
      "steam app list diff scan completed",
    );
    return {
      appListCount: apps.length,
      diffCount: result.changes.length,
      queuedCount: result.changes.length,
      verifiedCount: 0,
      excludedCount: 0,
      notifiedCandidates: 0,
      excludedReasons: {},
    };
  } catch (err) {
    if (err instanceof SteamAppListHttpError) {
      ctx.log.warn({ status: err.status, bodyPreview: err.bodyPreview }, "steam app list fetch failed");
    } else {
      ctx.log.warn({ err }, "steam app list fetch failed");
    }
    throw err;
  }
}

export async function processSteamVerifyQueue(ctx: BotContext, batchSize = DEFAULT_STEAM_VERIFY_BATCH_SIZE): Promise<GameDealFreeItem[]> {
  const repo = new GameDealRepository(ctx.sqlite);
  const changes = repo.listDueSteamVerifyQueue(batchSize);
  if (changes.length === 0) return [];
  const searchByAppid = await fetchSearchByAppid(ctx);
  const { items, summary } = await verifyChanges(ctx, changes, searchByAppid);
  ctx.log.info({ queuedBatch: changes.length, ...summary }, "steam verify queue processed");
  return items;
}

export function listActiveSteamFreeItems(ctx: BotContext, limit = 20): GameDealFreeItem[] {
  return new GameDealRepository(ctx.sqlite).listActiveSteamFreeEvents(limit).map(toFreeItem);
}

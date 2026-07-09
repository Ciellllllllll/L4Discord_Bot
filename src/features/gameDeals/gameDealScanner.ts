import type { BotContext } from "../../bot/context.js";
import { detectEpicFreeCandidates } from "../epic/epicFreeDetector.js";
import { buildEpicFreeEmbed } from "../epic/epicFreeEmbeds.js";
import { EpicStoreClient } from "../epic/epicStoreClient.js";
import { SteamStoreClient } from "../steam/steamStoreClient.js";
import type { SteamAppDetails } from "../steam/steamFreeTypes.js";
import { createGameDealRepository, GAME_DEALS_POSTGRES_DISABLED_MESSAGE } from "./postgresGameDealRepository.js";
import { listActiveSteamFreeItems } from "./steamFreeScanner.js";
import type {
  GameDealFreeItem,
  GameDealPlatform,
  GameDealScanResult,
  GameDealSourceStatus,
  GameDealSubscription,
  GameDealSubscriptionHit,
} from "./gameDealTypes.js";

function epicDedupeKey(candidate: ReturnType<typeof detectEpicFreeCandidates>[number]): string {
  return `epic:${candidate.dedupeKey}`;
}

export async function scanCurrentFreeGamesDetailed(ctx: BotContext): Promise<GameDealScanResult> {
  const tasks = [
    { platform: "steam" as const, promise: scanSteamCurrentFreeGamesWithStatus(ctx) },
    { platform: "epic" as const, promise: scanEpicCurrentFreeGamesWithStatus(ctx) },
  ];
  const results = await Promise.allSettled(tasks.map((task) => task.promise));
  const items: GameDealFreeItem[] = [];
  const sources: GameDealSourceStatus[] = [];
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i]!;
    if (result.status === "fulfilled") {
      items.push(...result.value.items);
      sources.push(result.value.source);
    } else {
      ctx.log.warn({ err: result.reason }, "game deal platform scan failed");
      sources.push({ platform: tasks[i]!.platform, status: "failed", message: "source failed" });
    }
  }
  return { items, sources };
}

async function scanSteamCurrentFreeGamesWithStatus(
  ctx: BotContext,
): Promise<{ items: GameDealFreeItem[]; source: GameDealSourceStatus }> {
  if (!createGameDealRepository(ctx)) {
    return {
      items: [],
      source: { platform: "steam", status: "unavailable", message: GAME_DEALS_POSTGRES_DISABLED_MESSAGE },
    };
  }
  return { items: await listActiveSteamFreeItems(ctx), source: { platform: "steam", status: "ok" } };
}

async function scanEpicCurrentFreeGamesWithStatus(
  ctx: BotContext,
): Promise<{ items: GameDealFreeItem[]; source: GameDealSourceStatus }> {
  const items = await scanEpicCurrentFreeGames(ctx);
  return { items, source: { platform: "epic", status: "ok" } };
}

async function scanEpicCurrentFreeGames(ctx: BotContext): Promise<GameDealFreeItem[]> {
  const epic = new EpicStoreClient(ctx.log);
  const offers = await epic.fetchFreePromotions();
  const items: GameDealFreeItem[] = [];
  for (const candidate of detectEpicFreeCandidates(offers)) {
    if (candidate.detectedType !== "current_free_game") continue;
    items.push({
      platform: "epic",
      title: candidate.title,
      dedupeKey: epicDedupeKey(candidate),
      embed: buildEpicFreeEmbed(candidate),
    });
  }
  return items;
}

export function parseGameStoreLink(link: string): { platform: GameDealPlatform; targetId: string; url: string } | null {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host === "store.steampowered.com" || host.endsWith(".steampowered.com")) {
    const appid = url.pathname.match(/\/app\/(\d+)/)?.[1];
    if (!appid || !/^\d+$/.test(appid)) return null;
    return { platform: "steam", targetId: appid, url: `https://store.steampowered.com/app/${appid}/` };
  }
  if (host === "store.epicgames.com" || host.endsWith(".epicgames.com")) {
    const slug = url.pathname.match(/\/p\/([^/?#]+)/)?.[1];
    if (!slug) return null;
    return { platform: "epic", targetId: decodeURIComponent(slug).replace(/\/home$/i, ""), url: link.trim() };
  }
  return null;
}

function steamPriceHit(sub: GameDealSubscription, details: SteamAppDetails): GameDealSubscriptionHit | null {
  const po = details.priceOverview;
  if (!po || typeof po.initial !== "number" || typeof po.final !== "number") return null;
  if (po.initial <= 0 || po.final >= po.initial) return null;
  const originalPrice = Math.round(po.initial / 100);
  const currentPrice = Math.round(po.final / 100);
  const discountPercent = po.discountPercent ?? Math.round((1 - po.final / po.initial) * 100);
  return {
    subscription: sub,
    title: details.name,
    url: sub.url,
    imageUrl: details.headerImage ?? details.capsuleImage ?? null,
    originalPrice,
    currentPrice,
    discountPercent,
    stateKey: `steam:${sub.targetId}:${po.final}:${po.discountPercent ?? "null"}`,
    platform: "steam",
  };
}

export async function checkSubscription(ctx: BotContext, sub: GameDealSubscription): Promise<GameDealSubscriptionHit | null> {
  if (sub.platform === "steam") {
    const details = await new SteamStoreClient(ctx.log).fetchAppDetails([sub.targetId]);
    const detail = details.get(sub.targetId);
    return detail ? steamPriceHit(sub, detail) : null;
  }
  const offers = await new EpicStoreClient(ctx.log).fetchFreePromotions();
  const candidates = detectEpicFreeCandidates(offers).filter((candidate) => candidate.detectedType === "current_free_game");
  const target = sub.targetId.toLowerCase();
  const matched = candidates.find((candidate) =>
    [candidate.productSlug, candidate.url, candidate.title].some((value) => value?.toLowerCase().includes(target)),
  );
  if (!matched) return null;
  return {
    subscription: sub,
    title: matched.title,
    url: matched.url,
    imageUrl: matched.imageUrl,
    originalPrice: matched.originalPrice,
    currentPrice: matched.discountPrice,
    discountPercent: matched.originalPrice && matched.discountPrice !== null
      ? Math.round((1 - matched.discountPrice / matched.originalPrice) * 100)
      : 100,
    stateKey: `epic:${matched.dedupeKey}`,
    platform: "epic",
  };
}

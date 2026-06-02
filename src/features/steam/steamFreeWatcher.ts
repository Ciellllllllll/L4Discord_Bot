import type { Client, SendableChannels } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { detectSteamFreeCandidates } from "./steamFreeDetector.js";
import { buildSteamFreeEmbed, buildSteamSummaryText } from "./steamFreeEmbeds.js";
import { SteamFreeRepository } from "./steamFreeRepository.js";
import { SteamStoreClient } from "./steamStoreClient.js";
import type { SteamFreeCandidate } from "./steamFreeTypes.js";

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const MAX_NOTIFY_PER_SCAN = 10;

async function scanSteam(ctx: BotContext, repo: SteamFreeRepository): Promise<SteamFreeCandidate[]> {
  const store = new SteamStoreClient(ctx.log);
  repo.markScanStarted();
  try {
    const searchItems = await store.fetchSearchItems(30);
    const details = await store.fetchAppDetails(searchItems.map((item) => item.appid));
    const candidates = detectSteamFreeCandidates(searchItems, details);
    for (const candidate of candidates) {
      repo.upsertSeen(candidate, false);
    }
    repo.markMissingInactive(candidates.map((c) => ({ appid: c.appid, detectedType: c.detectedType })));
    repo.markScanSuccess(candidates.length);
    return candidates;
  } catch (err) {
    repo.markScanError(err instanceof Error ? err.message : String(err));
    ctx.log.warn({ err }, "steam free scan failed");
    return [];
  }
}

async function fetchTextChannel(client: Client, channelId: string): Promise<SendableChannels | null> {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || channel.isDMBased() || !channel.isSendable()) return null;
  return channel;
}

async function sendCandidates(
  ctx: BotContext,
  channel: SendableChannels,
  candidates: SteamFreeCandidate[],
  repo: SteamFreeRepository,
): Promise<void> {
  const shown = candidates.slice(0, MAX_NOTIFY_PER_SCAN);
  if (shown.length === 0) return;
  const embeds = shown.map(buildSteamFreeEmbed);
  const content = buildSteamSummaryText(candidates.length, shown.length);
  try {
    await channel.send({ content, embeds, allowedMentions: { parse: [] } });
    for (const candidate of shown) repo.markNotified(candidate);
  } catch (err) {
    ctx.log.warn({ err }, "steam free notification send failed");
  }
}

export async function scanSteamFreeNow(ctx: BotContext): Promise<SteamFreeCandidate[]> {
  const repo = new SteamFreeRepository(ctx.sqlite);
  return await scanSteam(ctx, repo);
}

export async function scanAndNotifySteamFree(ctx: BotContext): Promise<void> {
  const repo = new SteamFreeRepository(ctx.sqlite);
  const channels = repo.listEnabledNotifyChannels();
  if (channels.length === 0) return;
  const candidates = await scanSteam(ctx, repo);
  const notifyCandidates: SteamFreeCandidate[] = [];
  for (const candidate of candidates) {
    const result = repo.upsertSeen(candidate, true);
    if (result.shouldNotify) notifyCandidates.push(candidate);
  }
  if (notifyCandidates.length === 0) return;
  for (const config of channels) {
    const channel = await fetchTextChannel(ctx.client, config.channelId);
    if (!channel) {
      ctx.log.warn({ guildId: config.guildId, channelId: config.channelId }, "steam free channel unavailable");
      repo.disableNotifyChannel(config.guildId);
      continue;
    }
    await sendCandidates(ctx, channel, notifyCandidates, repo);
  }
}

export function startSteamFreeWatcher(ctx: BotContext, intervalMs = DEFAULT_INTERVAL_MS): NodeJS.Timeout {
  let running = false;
  const tick = async () => {
    if (running) {
      ctx.log.warn("steam free watcher tick skipped because previous scan is still running");
      return;
    }
    running = true;
    try {
      await scanAndNotifySteamFree(ctx);
    } finally {
      running = false;
    }
  };
  ctx.log.info({ intervalMs }, "steam free watcher started");
  setTimeout(() => void tick().catch((err) => ctx.log.warn({ err }, "steam free startup scan failed")), 5_000);
  return setInterval(() => void tick().catch((err) => ctx.log.warn({ err }, "steam free watcher tick failed")), intervalMs);
}

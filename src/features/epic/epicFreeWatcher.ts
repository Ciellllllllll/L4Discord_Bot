import type { Client, SendableChannels } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { detectEpicFreeCandidates } from "./epicFreeDetector.js";
import { buildEpicFreeEmbed, buildEpicSummaryText } from "./epicFreeEmbeds.js";
import { EpicFreeRepository } from "./epicFreeRepository.js";
import { EpicStoreClient } from "./epicStoreClient.js";
import type { EpicFreeCandidate } from "./epicFreeTypes.js";

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_NOTIFY_PER_SCAN = 10;

async function scanEpic(ctx: BotContext, repo: EpicFreeRepository): Promise<EpicFreeCandidate[]> {
  const store = new EpicStoreClient(ctx.log);
  repo.markScanStarted();
  try {
    const offers = await store.fetchFreePromotions();
    const candidates = detectEpicFreeCandidates(offers);
    for (const candidate of candidates) {
      repo.upsertSeen(candidate, false);
    }
    repo.markMissingInactive(candidates.map((candidate) => candidate.dedupeKey));
    repo.markScanSuccess(candidates.filter((candidate) => candidate.detectedType === "current_free_game").length);
    return candidates;
  } catch (err) {
    repo.markScanError(err instanceof Error ? err.message : String(err));
    ctx.log.warn({ err }, "epic free scan failed");
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
  candidates: EpicFreeCandidate[],
  repo: EpicFreeRepository,
): Promise<void> {
  const shown = candidates.slice(0, MAX_NOTIFY_PER_SCAN);
  if (shown.length === 0) return;
  try {
    await channel.send({
      content: buildEpicSummaryText(candidates.length, shown.length),
      embeds: shown.map(buildEpicFreeEmbed),
      allowedMentions: { parse: [] },
    });
    for (const candidate of shown) repo.markNotified(candidate);
  } catch (err) {
    ctx.log.warn({ err }, "epic free notification send failed");
  }
}

export async function scanEpicFreeNow(ctx: BotContext): Promise<EpicFreeCandidate[]> {
  const repo = new EpicFreeRepository(ctx.sqlite);
  return await scanEpic(ctx, repo);
}

export async function scanAndNotifyEpicFree(ctx: BotContext): Promise<void> {
  const repo = new EpicFreeRepository(ctx.sqlite);
  const channels = repo.listEnabledNotifyChannels();
  if (channels.length === 0) return;
  const candidates = (await scanEpic(ctx, repo)).filter((candidate) => candidate.detectedType === "current_free_game");
  const notifyCandidates: EpicFreeCandidate[] = [];
  for (const candidate of candidates) {
    const result = repo.upsertSeen(candidate, true);
    if (result.shouldNotify) notifyCandidates.push(candidate);
  }
  if (notifyCandidates.length === 0) return;
  for (const config of channels) {
    const channel = await fetchTextChannel(ctx.client, config.channelId);
    if (!channel) {
      ctx.log.warn({ guildId: config.guildId, channelId: config.channelId }, "epic free channel unavailable");
      repo.disableNotifyChannel(config.guildId);
      continue;
    }
    await sendCandidates(ctx, channel, notifyCandidates, repo);
  }
}

export function startEpicFreeWatcher(ctx: BotContext, intervalMs = DEFAULT_INTERVAL_MS): NodeJS.Timeout {
  let running = false;
  const tick = async () => {
    if (running) {
      ctx.log.warn("epic free watcher tick skipped because previous scan is still running");
      return;
    }
    running = true;
    try {
      await scanAndNotifyEpicFree(ctx);
    } finally {
      running = false;
    }
  };
  ctx.log.info({ intervalMs }, "epic free watcher started");
  setTimeout(() => void tick().catch((err) => ctx.log.warn({ err }, "epic free startup scan failed")), 8_000);
  return setInterval(() => void tick().catch((err) => ctx.log.warn({ err }, "epic free watcher tick failed")), intervalMs);
}

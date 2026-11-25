// 川柳検出をスキップするチャンネル（権限不足時の自動ミュート等）

import type { Kysely } from "kysely";
import { getGuildSettingsData, upsertGuildSettingsData } from "../../core/guildSettings.js";
import type { Database } from "../../core/db/types.js";

const mutedChannelIds = new Set<string>();

export function muteChannelForSenryu(channelId: string): void {
  mutedChannelIds.add(channelId);
}

export function isChannelMutedForSenryu(channelId: string): boolean {
  return mutedChannelIds.has(channelId);
}

function normalizeChannelIds(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter((value) => /^\d+$/.test(value)))];
}

export function isChannelMutedBySettings(channelId: string, mutedChannelIdsFromSettings: unknown): boolean {
  return normalizeChannelIds(mutedChannelIdsFromSettings).includes(channelId);
}

export async function muteChannelForSenryuPersisted(
  db: Kysely<Database>,
  guildId: string,
  channelId: string,
): Promise<string[]> {
  muteChannelForSenryu(channelId);
  const settings = await getGuildSettingsData(db, guildId);
  const ids = new Set(normalizeChannelIds(settings.senryu_muted_channel_ids));
  ids.add(channelId);
  const next = [...ids];
  await upsertGuildSettingsData(db, guildId, { senryu_muted_channel_ids: next });
  return next;
}

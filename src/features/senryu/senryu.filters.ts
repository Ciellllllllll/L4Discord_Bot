// 川柳検出をスキップするチャンネル（権限不足時の自動ミュート等）

const mutedChannelIds = new Set<string>();

export function muteChannelForSenryu(channelId: string): void {
  mutedChannelIds.add(channelId);
}

export function isChannelMutedForSenryu(channelId: string): boolean {
  return mutedChannelIds.has(channelId);
}

export async function isDetectionOptedOut(_guildId: string, _userId: string): Promise<boolean> {
  return false;
}

export type PendingAppealStartCtx = {
  createdAt: number;
  guildId: string;
  userId: string;
  timeoutStart: number;
  timeoutEnd: number;
  punishmentType: string;
  punishmentReason: string;
  buttonFired: boolean;
  sourceChannelId: string | null;
  sourceMessageId: string | null;
  detecterIncidentId: string | null;
};

const pendingAppealStartContexts = new Map<string, PendingAppealStartCtx>();
const PENDING_TTL_MS = 30 * 60 * 1000;
const CLEANUP_MS = 30 * 1000;

function cleanupPendingAppealStartContexts(): void {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [key, value] of pendingAppealStartContexts.entries()) {
    if (value.createdAt < cutoff) pendingAppealStartContexts.delete(key);
  }
}

setInterval(cleanupPendingAppealStartContexts, CLEANUP_MS).unref?.();

export function createPendingAppealStartContext(input: {
  guildId: string;
  userId: string;
  timeoutStart: number;
  timeoutEnd: number;
  punishmentType: string;
  punishmentReason: string;
  detecterIncidentId: string | null;
}): string {
  cleanupPendingAppealStartContexts();
  const ctxId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  pendingAppealStartContexts.set(ctxId, {
    createdAt: Date.now(),
    guildId: input.guildId,
    userId: input.userId,
    timeoutStart: input.timeoutStart,
    timeoutEnd: input.timeoutEnd,
    punishmentType: input.punishmentType,
    punishmentReason: input.punishmentReason,
    buttonFired: false,
    sourceChannelId: null,
    sourceMessageId: null,
    detecterIncidentId: input.detecterIncidentId,
  });
  return ctxId;
}

export function getPendingAppealStartContext(ctxId: string): PendingAppealStartCtx | undefined {
  return pendingAppealStartContexts.get(ctxId);
}

export function deletePendingAppealStartContext(ctxId: string): void {
  pendingAppealStartContexts.delete(ctxId);
}

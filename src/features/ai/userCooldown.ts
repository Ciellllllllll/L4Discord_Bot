const lastByUser = new Map<string, number>();

export function canUseAi(userId: string, cooldownMs: number): boolean {
  const now = Date.now();
  const prev = lastByUser.get(userId) ?? 0;
  return now - prev >= cooldownMs;
}

export function markAiUse(userId: string): void {
  lastByUser.set(userId, Date.now());
}

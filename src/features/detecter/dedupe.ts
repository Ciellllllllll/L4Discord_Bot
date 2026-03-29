const seen = new Set<string>();
const MAX = 10_000;

export function consumeAuditKey(key: string): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  if (seen.size > MAX) {
    const it = seen.values();
    for (let i = 0; i < MAX / 2; i++) {
      const n = it.next();
      if (n.done) break;
      seen.delete(n.value);
    }
  }
  return true;
}

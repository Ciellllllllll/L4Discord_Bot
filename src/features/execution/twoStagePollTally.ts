// 二段階投票の集計など、閉じ込められた状態に依存しない純粋な処理。

export function parsePersistedFlowState<T>(value: unknown, parse: (value: unknown) => T | null): T | null {
  let decoded = value;
  if (typeof decoded === "string") {
    try {
      decoded = JSON.parse(decoded);
    } catch {
      return null;
    }
  }
  return parse(decoded);
}

export function tallyChoices<T extends string>(votes: Readonly<Record<string, string>>, keys: readonly T[]): Record<T, number> {
  const counts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
  for (const choice of Object.values(votes)) {
    if (Object.hasOwn(counts, choice)) counts[choice as T] += 1;
  }
  return counts;
}

export function pickSingleWinner<T extends string>(counts: Readonly<Record<T, number>>, keys: readonly T[]): T | null {
  let max = 0;
  let winner: T | null = null;
  let tied = false;
  for (const key of keys) {
    const count = counts[key] ?? 0;
    if (count > max) {
      max = count;
      winner = key;
      tied = false;
    } else if (count === max && count > 0) {
      tied = true;
    }
  }
  return max > 0 && !tied ? winner : null;
}

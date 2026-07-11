export type VcRankingInterval = {
  startMs: number;
  endMs: number;
};

export function mergedIntervalSeconds(intervals: VcRankingInterval[]): number {
  const sorted = intervals
    .filter((interval) => Number.isFinite(interval.startMs) && Number.isFinite(interval.endMs) && interval.endMs > interval.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  let totalMs = 0;
  let currentStart: number | null = null;
  let currentEnd: number | null = null;

  for (const interval of sorted) {
    if (currentStart === null || currentEnd === null) {
      currentStart = interval.startMs;
      currentEnd = interval.endMs;
      continue;
    }
    if (interval.startMs <= currentEnd) {
      currentEnd = Math.max(currentEnd, interval.endMs);
      continue;
    }
    totalMs += currentEnd - currentStart;
    currentStart = interval.startMs;
    currentEnd = interval.endMs;
  }

  if (currentStart !== null && currentEnd !== null) {
    totalMs += currentEnd - currentStart;
  }

  return Math.floor(totalMs / 1000);
}

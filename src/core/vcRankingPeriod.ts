export type VcRankingPeriodKey = "day" | "week" | "month" | "all";

function gregorianToJdn(y: number, m: number, d: number): number {
  const a = Math.floor((14 - m) / 12);
  const y2 = y + 4800 - a;
  const m2 = m + 12 * a - 3;
  return (
    d +
    Math.floor((153 * m2 + 2) / 5) +
    365 * y2 +
    Math.floor(y2 / 4) -
    Math.floor(y2 / 100) +
    Math.floor(y2 / 400) -
    32045
  );
}

function jdnToGregorian(j: number): { y: number; m: number; d: number } {
  const a = j + 32044;
  const b = Math.floor((4 * a + 3) / 146097);
  const c = a - Math.floor((146097 * b) / 4);
  const d = Math.floor((4 * c + 3) / 1461);
  const e = c - Math.floor((1461 * d) / 4);
  const m2 = Math.floor((5 * e + 2) / 153);
  const day = e - Math.floor((153 * m2 + 2) / 5) + 1;
  const month = m2 + 3 - 12 * Math.floor(m2 / 10);
  const year = 100 * b + d - 4800 + Math.floor(m2 / 10);
  return { y: year, m: month, d: day };
}

export function zonedYmdFromUtcMs(timeZone: string, ms: number): { y: number; m: number; d: number } {
  const s = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
  const [y, m, d] = s.split("-").map((x) => +x);
  return { y, m, d };
}

function zonedWeekdaySun0(timeZone: string, ms: number): number {
  const w = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(new Date(ms));
  const key = w.slice(0, 3);
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[key] ?? 0;
}

export function zonedWallTimeToUtcMs(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number | null {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const read = (ms: number) => {
    const o = { y: 0, m: 0, d: 0, H: 0, M: 0, S: 0 };
    for (const { type, value } of fmt.formatToParts(new Date(ms))) {
      if (type === "year") o.y = +value;
      if (type === "month") o.m = +value;
      if (type === "day") o.d = +value;
      if (type === "hour") o.H = +value;
      if (type === "minute") o.M = +value;
      if (type === "second") o.S = +value;
    }
    return o;
  };
  const matches = (ms: number) => {
    const p = read(ms);
    return p.y === year && p.m === month && p.d === day && p.H === hour && p.M === minute && p.S === second;
  };
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetAt = (ms: number) => {
    const p = read(ms);
    return Date.UTC(p.y, p.m - 1, p.d, p.H, p.M, p.S) - ms;
  };

  // Two-step fixed-point solve handles DST transitions; check earlier offset first for fall-back ambiguity.
  const offset1 = offsetAt(targetAsUtc);
  const candidate1 = targetAsUtc - offset1;
  const offset2 = offsetAt(candidate1);
  const candidate2 = targetAsUtc - offset2;
  const candidates = candidate2 < candidate1 ? [candidate2, candidate1] : [candidate1, candidate2];
  for (const ms of candidates) {
    if (matches(ms)) return ms;
  }
  return null;
}

// started_at に使う ISO8601（UTC Z）。period が all のときは null。
// 週は月曜始まり（従来ロジックと同じ）。

export function vcRankingPeriodStartIso(
  period: VcRankingPeriodKey,
  timeZone: string,
  nowMs = Date.now(),
): string | null {
  if (period === "all") return null;
  const { y, m, d } = zonedYmdFromUtcMs(timeZone, nowMs);
  if (period === "day") {
    const t = zonedWallTimeToUtcMs(timeZone, y, m, d, 0, 0, 0);
    return new Date(t ?? Date.UTC(y, m - 1, d, 0, 0, 0)).toISOString();
  }
  if (period === "month") {
    const t = zonedWallTimeToUtcMs(timeZone, y, m, 1, 0, 0, 0);
    return new Date(t ?? Date.UTC(y, m - 1, 1, 0, 0, 0)).toISOString();
  }
  
  const j = gregorianToJdn(y, m, d);
  const noonMs = zonedWallTimeToUtcMs(timeZone, y, m, d, 12, 0, 0) ?? nowMs;
  const wd = zonedWeekdaySun0(timeZone, noonMs);
  const daysFromMonday = wd === 0 ? 6 : wd - 1;
  const { y: y0, m: m0, d: d0 } = jdnToGregorian(j - daysFromMonday);
  const t = zonedWallTimeToUtcMs(timeZone, y0, m0, d0, 0, 0, 0);
  return new Date(t ?? Date.UTC(y0, m0 - 1, d0, 0, 0, 0)).toISOString();
}

/** モーラ計測で数えない小書き（仕様） */
const SMALL_KANA = new Set(["ァ", "ィ", "ゥ", "ェ", "ォ", "ャ", "ュ", "ョ"]);

export function countAmbiguousInReading(reading: string): number {
  let n = 0;
  for (const ch of reading) {
    if (ch === "ッ" || ch === "ー") n += 1;
  }
  return n;
}

/**
 * モーラ近似: 小書きは数えない。ッ・ーは countMora に含めず曖昧用に別計上。
 */
export function countMora(reading: string): number {
  let n = 0;
  for (const ch of reading) {
    if (SMALL_KANA.has(ch)) continue;
    if (ch === "ッ" || ch === "ー") continue;
    if (/[ァ-ヾ]/.test(ch)) n += 1;
  }
  return n;
}

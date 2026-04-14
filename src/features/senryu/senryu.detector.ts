import { countAmbiguousInReading, countMora } from "./senryu.counter.js";
import { isDigitOnlyToken, isSkippableInterwordToken, resolveReading } from "./senryu.kuromoji.js";
import type { KuromojiToken, SenryuCandidate } from "./senryu.types.js";

export type SenryuMoraTolerance = 0 | 1;

export function isValidPhraseStart(token: KuromojiToken): boolean {
  const [pos, d1, d2] = token.pos;
  if (d1 === "非自立" || d2 === "非自立") return false;
  if (d1 === "接尾" || d2 === "接尾") return false;
  if (d1 === "接尾辞" || d2 === "接尾辞") return false;

  if (pos === "助詞") {
    return d1 === "接続助詞" || d1 === "副詞化" || d1 === "副助詞";
  }
  if (pos === "助動詞") return false;
  if (pos === "補助記号") return false;

  const ok = new Set([
    "名詞",
    "形容詞",
    "動詞",
    "副詞",
    "連体詞",
    "接続詞",
    "感動詞",
    "接頭詞",
    "記号",
    "形状詞",
  ]);
  if (ok.has(pos)) return true;
  if (pos === "名詞" && d1 === "代名詞") return true;
  return false;
}

export function isValidPhraseEnd(token: KuromojiToken): boolean {
  const [pos, d1] = token.pos;
  if (pos === "接頭詞") return false;
  if (d1 === "非自立") return false;
  if (token.cForm.includes("未然")) return false;
  if (pos === "助詞") {
    if (d1 === "接続助詞" || d1 === "副詞化") return false;
  }
  if (pos === "助動詞") return false;
  return true;
}

function phraseCompletes(
  newRemain: number,
  newAmb: number,
  moraTolerance: SenryuMoraTolerance,
): boolean {
  if (newRemain === 0 || newRemain + newAmb === 0) return true;
  if (moraTolerance < 1) return false;
  return newAmb === 0 && (newRemain === 1 || newRemain === -1);
}

export function senryuCandidate575MismatchScore(candidate: SenryuCandidate): number {
  const [a, b, c] = candidate.moraUsed;
  return Math.abs(a - 5) + Math.abs(b - 7) + Math.abs(c - 5);
}

export function extractAll575(
  tokens: KuromojiToken[],
  moraTolerance: SenryuMoraTolerance = 0,
): SenryuCandidate[] {
  const candidates: SenryuCandidate[] = [];
  const rule: readonly [number, number, number] = [5, 7, 5];

  outer: for (let start = 0; start < tokens.length; start++) {
    const remain: number[] = [...rule];
    let phraseIndex = 0;
    const parts: [string, string, string] = ["", "", ""];
    const phraseConsumed: [number, number, number] = [0, 0, 0];
    let ambiguousCount = 0;
    let i = start;

    while (i < tokens.length) {
      const t = tokens[i]!;
      if (isDigitOnlyToken(t)) {
        break;
      }
      if (isSkippableInterwordToken(t)) {
        i += 1;
        continue;
      }
      const reading = resolveReading(t);
      if (reading === null) {
        break;
      }

      const firstInPhrase = parts[phraseIndex] === "";
      if (firstInPhrase && !isValidPhraseStart(t)) {
        break;
      }

      const mora = countMora(reading);
      const amb = countAmbiguousInReading(reading);

      const rBefore = remain[phraseIndex]!;
      const ambBefore = ambiguousCount;
      const newRemain = rBefore - mora;
      const newAmb = ambBefore + amb;

      const completes = phraseCompletes(newRemain, newAmb, moraTolerance);

      if (!completes) {
        if (moraTolerance >= 1) {
          if (newRemain < -1) break;
          if (newRemain === -1 && newAmb > 0 && newRemain + newAmb !== 0) break;
        } else if (newRemain < 0) {
          break;
        }
        remain[phraseIndex] = newRemain;
        ambiguousCount = newAmb;
        parts[phraseIndex] += t.surface;
        phraseConsumed[phraseIndex] += mora;
        i += 1;
        continue;
      }

      if (!isValidPhraseEnd(t)) {
        break;
      }

      parts[phraseIndex] += t.surface;
      remain[phraseIndex] = newRemain;
      ambiguousCount = newAmb;
      phraseConsumed[phraseIndex] += mora;

      if (phraseIndex < 2) {
        phraseIndex += 1;
        ambiguousCount = 0;
        i += 1;
        continue;
      }

      const kamigo = parts[0]!.trim();
      const nakashichi = parts[1]!.trim();
      const shimogo = parts[2]!.trim();
      const formatted = `${kamigo} ${nakashichi} ${shimogo}`;
      candidates.push({
        kamigo,
        nakashichi,
        shimogo,
        formatted,
        tokenSpan: { start, end: i + 1 },
        moraUsed: [...phraseConsumed] as [number, number, number],
      });
      continue outer;
    }
  }

  return candidates;
}

export type PickSenryuCandidateOptions = {
  moraTolerance: SenryuMoraTolerance;
  bestCandidate: boolean;
};

export function pickSenryuCandidate(
  tokens: KuromojiToken[],
  options: PickSenryuCandidateOptions,
): SenryuCandidate | null {
  const all = extractAll575(tokens, options.moraTolerance);
  if (all.length === 0) return null;
  if (!options.bestCandidate) return all[0]!;
  let best = all[0]!;
  let bestScore = senryuCandidate575MismatchScore(best);
  for (let k = 1; k < all.length; k++) {
    const c = all[k]!;
    const s = senryuCandidate575MismatchScore(c);
    if (s < bestScore || (s === bestScore && c.tokenSpan.start < best.tokenSpan.start)) {
      best = c;
      bestScore = s;
    }
  }
  return best;
}

// 後方互換: 厳密 5/7/5 かつ先頭候補のみ。許容・複数候補からの選抜は pickSenryuCandidate を使う。

export function detectFirst575(tokens: KuromojiToken[]): SenryuCandidate | null {
  return pickSenryuCandidate(tokens, { moraTolerance: 0, bestCandidate: false });
}

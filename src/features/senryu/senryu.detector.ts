import { countAmbiguousInReading, countMora } from "./senryu.counter.js";
import { isDigitOnlyToken, resolveReading } from "./senryu.kuromoji.js";
import type { KuromojiToken, SenryuCandidate } from "./senryu.types.js";

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

export function extractAll575(tokens: KuromojiToken[]): SenryuCandidate[] {
  const candidates: SenryuCandidate[] = [];
  const rule = [5, 7, 5];

  outer: for (let start = 0; start < tokens.length; start++) {
    const remain = [...rule];
    let phraseIndex = 0;
    const parts: [string, string, string] = ["", "", ""];
    let ambiguousCount = 0;
    let i = start;

    while (i < tokens.length) {
      const t = tokens[i]!;
      if (isDigitOnlyToken(t)) {
        break;
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

      const completes = newRemain === 0 || newRemain + newAmb === 0;

      if (!completes) {
        if (newRemain < 0) {
          break;
        }
        remain[phraseIndex] = newRemain;
        ambiguousCount = newAmb;
        parts[phraseIndex] += t.surface;
        i += 1;
        continue;
      }

      if (!isValidPhraseEnd(t)) {
        break;
      }

      parts[phraseIndex] += t.surface;
      remain[phraseIndex] = newRemain;
      ambiguousCount = newAmb;

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
      candidates.push({ kamigo, nakashichi, shimogo, formatted });
      continue outer;
    }
  }

  return candidates;
}

export function detectFirst575(tokens: KuromojiToken[]): SenryuCandidate | null {
  const all = extractAll575(tokens);
  return all[0] ?? null;
}

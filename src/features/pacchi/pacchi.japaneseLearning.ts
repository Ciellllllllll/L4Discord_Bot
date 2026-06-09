import type { AnalyzeMorphResponse, JapaneseMorphToken } from "../japaneseAnalysis/japaneseAnalysis.types.js";
import type { PacchiLexiconInput, PacchiSentencePatternInput } from "./pacchi.types.js";
import { isUnsafeForPacchiLearning } from "./pacchi.safety.js";

const allowedParticles = new Set(["は", "が", "を", "に", "で", "と", "の", "も", "って", "ね", "かも", "かな"]);

function hasPos(token: JapaneseMorphToken, value: string): boolean {
  return token.pos.includes(value);
}

function isDigitsOnly(value: string): boolean {
  return /^[0-9０-９]+$/.test(value);
}

export function toLearnableLexiconTokens(response: AnalyzeMorphResponse): PacchiLexiconInput[] {
  return response.tokens
    .filter((token) => {
      if (!token.surface.trim()) return false;
      if (token.surface.length <= 1) return false;
      if (isDigitsOnly(token.surface)) return false;
      if (!token.reading || (token.isOov && token.reading === token.surface)) return false;
      if (hasPos(token, "助詞") || hasPos(token, "助動詞")) return false;
      if (hasPos(token, "接頭辞") || hasPos(token, "接尾辞")) return false;
      if (hasPos(token, "補助記号") || hasPos(token, "記号") || hasPos(token, "空白")) return false;
      return (
        hasPos(token, "名詞") ||
        hasPos(token, "固有名詞") ||
        hasPos(token, "普通名詞") ||
        hasPos(token, "サ変可能") ||
        hasPos(token, "動詞") ||
        hasPos(token, "形容詞") ||
        hasPos(token, "副詞") ||
        hasPos(token, "感動詞")
      );
    })
    .map((token) => ({
      surface: token.surface,
      base: token.base || token.surface,
      reading: token.reading,
      pos: token.pos,
      isProperNoun: token.isProperNoun,
      isOov: token.isOov,
      source: "morph",
    }));
}

function slotForToken(token: JapaneseMorphToken): string | null {
  if (token.isProperNoun || hasPos(token, "固有名詞")) return "PROPER_NOUN";
  if (hasPos(token, "名詞") || hasPos(token, "普通名詞")) return "NOUN";
  if (hasPos(token, "動詞")) return "VERB";
  if (hasPos(token, "形容詞")) return "ADJECTIVE";
  if (hasPos(token, "副詞")) return "ADVERB";
  return null;
}

export function buildSentencePattern(
  content: string,
  response: AnalyzeMorphResponse,
): PacchiSentencePatternInput | null {
  const text = content.trim();
  if (isUnsafeForPacchiLearning(text)) return null;
  if (text.length < 5 || text.length > 40) return null;
  if (text.startsWith("/") || text.startsWith("!")) return null;

  const slots: string[] = [];
  const parts: string[] = [];
  let meaningful = 0;
  for (const token of response.tokens) {
    const slot = slotForToken(token);
    if (slot) {
      parts.push(`{${slot}}`);
      slots.push(slot);
      meaningful++;
      continue;
    }
    if (hasPos(token, "助詞") && allowedParticles.has(token.surface)) {
      parts.push(token.surface);
    }
  }
  if (meaningful === 0) return null;
  if (slots.length > 0 && slots.every((slot) => slot === "PROPER_NOUN") && parts.every((part) => part === "{PROPER_NOUN}")) {
    return null;
  }
  const surfacePattern = parts.join("").trim();
  if (!surfacePattern || surfacePattern.length < 3) return null;
  return {
    surfacePattern,
    slots,
    ending: text.slice(-3),
    sourceKind: "message",
    safeLevel: 1,
  };
}

import { analyzeSenryu } from "../japaneseAnalysis/japaneseAnalysisClient.js";
import type { JapaneseAnalysisClientOptions, JapaneseWorkerFailureReason } from "../japaneseAnalysis/japaneseAnalysis.types.js";
import { sanitizeForReply } from "./pacchi.filters.js";

export type PacchiVerifiedPoemResult =
  | { ok: true; poem: string }
  | { ok: false; reason: "invalid_pattern" | "no_match" | "worker_failed"; workerReason?: JapaneseWorkerFailureReason; error?: unknown };

const fallbackWords = ["ぱっちぃ", "ことば", "コード", "月あかり", "静かな朝", "風"];

const fiveLineTemplates = [
  "{word}かな",
  "{word}かも",
  "{word}だね",
  "{word}ひかる",
  "春の{word}",
  "夜の{word}",
] as const;

const sevenLineTemplates = [
  "{word}が揺れて",
  "{word}を探す",
  "{word}の話",
  "{word}がひかる",
  "静かな{word}",
  "みんなで{word}",
] as const;

function buildLineCandidates(words: string[], templates: readonly string[]): string[] {
  const out = new Set<string>();
  for (const word of words) {
    for (const template of templates) {
      const line = template.replace("{word}", word).replace(/\s+/g, "").trim();
      if (line.length >= 2 && line.length <= 18) out.add(line);
    }
  }
  return [...out];
}

function safeSourceWords(words: string[]): string[] {
  const safe = words
    .map((word) => sanitizeForReply(word))
    .filter((word): word is string => Boolean(word))
    .filter((word) => !/^[0-9０-９]+$/.test(word))
    .slice(0, 12);
  return safe.length > 0 ? safe : fallbackWords;
}

export function buildPacchiPoemCandidates(pattern: string, words: string[], maxCandidates = 80): string[] {
  if (pattern !== "575") return [];

  const source = safeSourceWords(words);
  const fiveLines = buildLineCandidates(source, fiveLineTemplates);
  const sevenLines = buildLineCandidates(source, sevenLineTemplates);
  const candidates: string[] = [];

  for (let i = 0; i < maxCandidates; i++) {
    const upper = fiveLines[i % fiveLines.length];
    const middle = sevenLines[(i * 3 + 1) % sevenLines.length];
    const lower = fiveLines[(i * 5 + 2) % fiveLines.length];
    if (!upper || !middle || !lower) break;
    candidates.push(`${upper}\n${middle}\n${lower}`);
  }

  return candidates;
}

export async function buildVerifiedPacchiPoem(
  pattern: string,
  words: string[],
  options: JapaneseAnalysisClientOptions,
): Promise<PacchiVerifiedPoemResult> {
  const candidates = buildPacchiPoemCandidates(pattern, words);
  if (candidates.length === 0) return { ok: false, reason: "invalid_pattern" };

  for (const candidate of candidates) {
    const result = await analyzeSenryu(candidate, options);
    if (!result.ok) {
      return { ok: false, reason: "worker_failed", workerReason: result.reason, error: result.error };
    }
    if (result.data.matched && result.data.phrases.length === 3) {
      return { ok: true, poem: result.data.phrases.join("\n") };
    }
  }

  return { ok: false, reason: "no_match" };
}

export function pacchiVerifiedPoemFailureMessage(result: Exclude<PacchiVerifiedPoemResult, { ok: true }>): string {
  if (result.reason === "invalid_pattern") return "使い方: `!pacchi_poem 575`";
  if (result.reason === "worker_failed") return "575、いま数えられないかも";
  return "ぱっちぃには575を作れなかった";
}

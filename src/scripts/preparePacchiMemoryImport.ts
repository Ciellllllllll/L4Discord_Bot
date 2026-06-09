import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import kuromoji from "kuromoji";
import type { IpadicToken } from "kuromoji";
import { buildSentencePattern } from "../features/pacchi/pacchi.japaneseLearning.js";
import type {
  PacchiCooccurrenceExportEntry,
  PacchiExportData,
  PacchiLexiconExportEntry,
  PacchiSentencePatternExportEntry,
  PacchiUserDictionaryExportEntry,
} from "../features/pacchi/pacchi.types.js";
import type { AnalyzeMorphResponse, JapaneseMorphToken } from "../features/japaneseAnalysis/japaneseAnalysis.types.js";

const require = createRequire(import.meta.url);
const COUNT_MAX = 100_000_000;

type BasicPacchiMemory = PacchiExportData & Record<string, unknown>;

function defaultKuromojiDictPath(): string {
  return join(dirname(require.resolve("kuromoji/package.json")), "dict");
}

async function buildTokenizer(): Promise<import("kuromoji").Tokenizer> {
  return await new Promise((resolveTokenizer, reject) => {
    kuromoji.builder({ dicPath: defaultKuromojiDictPath() }).build((err, tokenizer) => {
      if (err) reject(err);
      else resolveTokenizer(tokenizer);
    });
  });
}

function clampCount(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 1;
  return Math.min(COUNT_MAX, Math.max(1, n));
}

function cleanPart(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s || s === "*") return null;
  return s;
}

function toMorphToken(token: IpadicToken): JapaneseMorphToken {
  const surface = token.surface_form;
  const base = cleanPart(token.basic_form) ?? surface;
  const reading = cleanPart(token.reading) ?? cleanPart(token.pronunciation) ?? surface;
  const pos = [
    cleanPart(token.pos),
    cleanPart(token.pos_detail_1),
    cleanPart(token.pos_detail_2),
    cleanPart(token.pos_detail_3),
  ].filter((v): v is string => Boolean(v));
  const isProperNoun = pos.includes("固有名詞");
  const isOov = token.word_type !== "KNOWN";
  return { surface, base, reading, pos: pos.length > 0 ? pos : ["未知語"], isProperNoun, isOov };
}

function hasPos(token: JapaneseMorphToken, value: string): boolean {
  return token.pos.includes(value);
}

function isDigitsOnly(value: string): boolean {
  return /^[0-9０-９]+$/.test(value);
}

function isLearnableToken(token: JapaneseMorphToken): boolean {
  if (!token.surface.trim()) return false;
  if (token.surface.length <= 1) return false;
  if (isDigitsOnly(token.surface)) return false;
  if (hasPos(token, "助詞") || hasPos(token, "助動詞")) return false;
  if (hasPos(token, "接頭詞") || hasPos(token, "接頭辞") || hasPos(token, "接尾辞")) return false;
  if (hasPos(token, "補助記号") || hasPos(token, "記号") || hasPos(token, "空白")) return false;
  return (
    hasPos(token, "名詞") ||
    hasPos(token, "固有名詞") ||
    hasPos(token, "普通名詞") ||
    hasPos(token, "サ変接続") ||
    hasPos(token, "サ変可能") ||
    hasPos(token, "動詞") ||
    hasPos(token, "形容詞") ||
    hasPos(token, "副詞") ||
    hasPos(token, "感動詞")
  );
}

function analyze(tokenizer: import("kuromoji").Tokenizer, text: string): AnalyzeMorphResponse {
  return { tokens: tokenizer.tokenize(text).map(toMorphToken), error: null };
}

function addCount(map: Map<string, number>, key: string, count: number): void {
  map.set(key, (map.get(key) ?? 0) + count);
}

function pairKey(a: string, b: string): string {
  return a <= b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

function addAnalyzedText(
  text: string,
  count: number,
  response: AnalyzeMorphResponse,
  lexicon: Map<string, PacchiLexiconExportEntry>,
  userDictionary: Map<string, PacchiUserDictionaryExportEntry>,
  cooccurrences: Map<string, number>,
  patterns: Map<string, PacchiSentencePatternExportEntry>,
): void {
  const tokens = response.tokens.filter(isLearnableToken);
  for (const token of tokens) {
    const pos = token.pos.length > 0 ? token.pos : ["未知語"];
    const key = `${token.base}\u0000${JSON.stringify(pos)}`;
    const existing = lexicon.get(key);
    if (existing) {
      existing.count = Math.min(COUNT_MAX, existing.count + count);
    } else {
      lexicon.set(key, {
        surface: token.surface,
        base: token.base || token.surface,
        reading: token.reading || token.surface,
        pos,
        isProperNoun: token.isProperNoun,
        isOov: token.isOov,
        source: "import_kuromoji",
        count,
      });
    }
    if (token.isProperNoun || token.isOov) {
      const dictKey = `${token.surface}\u0000${token.reading || token.surface}`;
      const existingDict = userDictionary.get(dictKey);
      if (existingDict) {
        existingDict.count = Math.min(COUNT_MAX, existingDict.count + count);
      } else {
        userDictionary.set(dictKey, {
          surface: token.surface,
          reading: token.reading || token.surface,
          reason: token.isProperNoun ? "proper_noun" : "oov",
          count,
        });
      }
    }
  }

  const bases = [...new Set(tokens.map((token) => token.base || token.surface))].sort();
  for (let i = 0; i < bases.length; i++) {
    for (let j = i + 1; j < bases.length; j++) {
      addCount(cooccurrences, pairKey(bases[i]!, bases[j]!), count);
    }
  }

  const pattern = buildSentencePattern(text, response);
  if (pattern) {
    const existing = patterns.get(pattern.surfacePattern);
    if (existing) {
      existing.count = Math.min(COUNT_MAX, existing.count + count);
      existing.safeLevel = Math.min(existing.safeLevel, pattern.safeLevel);
    } else {
      patterns.set(pattern.surfacePattern, { ...pattern, sourceKind: "import_kuromoji", count });
    }
  }
}

function normalizeMemory(raw: BasicPacchiMemory): PacchiExportData {
  return {
    ...raw,
    version: 1,
    exportedAt: new Date().toISOString(),
    words: (raw.words ?? []).map((row) => ({ word: row.word, count: clampCount(row.count) })),
    phrases: (raw.phrases ?? []).map((row) => ({ phrase: row.phrase, count: clampCount(row.count) })),
    emojis: (raw.emojis ?? []).map((row) => ({ ...row, count: clampCount(row.count) })),
    settings: raw.settings ?? null,
    ngWords: raw.ngWords ?? [],
  };
}

async function main(): Promise<void> {
  const input = process.argv[2];
  const output = process.argv[3] ?? "pacchi-memory-newdb.json";
  if (!input) {
    throw new Error("Usage: tsx src/scripts/preparePacchiMemoryImport.ts <input.json> [output.json]");
  }

  const source = normalizeMemory(JSON.parse(readFileSync(input, "utf8")) as BasicPacchiMemory);
  const tokenizer = await buildTokenizer();
  const lexicon = new Map<string, PacchiLexiconExportEntry>();
  const userDictionary = new Map<string, PacchiUserDictionaryExportEntry>();
  const cooccurrences = new Map<string, number>();
  const patterns = new Map<string, PacchiSentencePatternExportEntry>();

  for (const row of source.words) {
    addAnalyzedText(row.word, row.count, analyze(tokenizer, row.word), lexicon, userDictionary, cooccurrences, patterns);
  }
  for (const row of source.phrases) {
    addAnalyzedText(row.phrase, row.count, analyze(tokenizer, row.phrase), lexicon, userDictionary, cooccurrences, patterns);
  }

  const lexiconEntries = [...lexicon.values()].sort((a, b) => b.count - a.count || a.base.localeCompare(b.base, "ja"));
  const userDictionaryEntries = [...userDictionary.values()].sort((a, b) => b.count - a.count || a.surface.localeCompare(b.surface, "ja"));
  const cooccurrenceEntries = [...cooccurrences.entries()]
    .map(([key, count]): PacchiCooccurrenceExportEntry => {
      const [wordA, wordB] = key.split("\u0000");
      return { wordA: wordA!, wordB: wordB!, count: clampCount(count) };
    })
    .sort((a, b) => b.count - a.count || a.wordA.localeCompare(b.wordA, "ja"));
  const sentencePatternEntries = [...patterns.values()]
    .sort((a, b) => b.count - a.count || a.surfacePattern.localeCompare(b.surfacePattern, "ja"));

  const enriched: PacchiExportData = {
    ...source,
    lexicon: lexiconEntries,
    userDictionaryEntries,
    cooccurrences: cooccurrenceEntries,
    sentencePatterns: sentencePatternEntries,
  };

  writeFileSync(output, `${JSON.stringify(enriched, null, 2)}\n`, "utf8");
  console.log(`wrote ${resolve(output)}`);
  console.log(`lexicon=${lexiconEntries.length} cooccurrences=${cooccurrenceEntries.length} userDictionary=${userDictionaryEntries.length} sentencePatterns=${sentencePatternEntries.length}`);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

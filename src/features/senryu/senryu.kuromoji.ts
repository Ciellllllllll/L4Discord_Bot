import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import kuromoji from "kuromoji";
import type { IpadicToken } from "kuromoji";
import type pino from "pino";
import { KATAKANA_ONLY_PATTERN } from "./senryu.constants.js";
import type { KuromojiToken } from "./senryu.types.js";

const require = createRequire(import.meta.url);

// kuromoji のデフォルトは cwd 相対の dict/ のため、npm 同梱辞書へ固定する

function defaultKuromojiDictPath(): string {
  return join(dirname(require.resolve("kuromoji/package.json")), "dict");
}

let tokenizer: import("kuromoji").Tokenizer | null = null;

export function isKuromojiTokenizerReady(): boolean {
  return tokenizer !== null;
}

export async function initKuromojiTokenizer(
  dicPath: string | undefined,
  log: pino.Logger,
): Promise<void> {
  try {
    const resolvedDicPath = dicPath ?? defaultKuromojiDictPath();
    const builder = kuromoji.builder({ dicPath: resolvedDicPath });
    await new Promise<void>((resolve, reject) => {
      builder.build((err, t) => {
        if (err) reject(err);
        else {
          tokenizer = t;
          resolve();
        }
      });
    });
    log.info({ dicPath: resolvedDicPath }, "kuromoji tokenizer initialized");
  } catch (err) {
    tokenizer = null;
    log.error({ err }, "kuromoji tokenizer init failed (senryu disabled)");
  }
}

function padPos(
  pos: string,
  d1: string,
  d2: string,
  d3: string,
): [string, string, string, string] {
  return [pos || "*", d1 || "*", d2 || "*", d3 || "*"];
}

export function mapIpadicTokenToKuromoji(t: IpadicToken): KuromojiToken {
  const reading = t.reading && t.reading !== "*" ? t.reading : "";
  const pronunciation = t.pronunciation && t.pronunciation !== "*" ? t.pronunciation : "";
  return {
    surface: t.surface_form,
    pos: padPos(t.pos, t.pos_detail_1, t.pos_detail_2, t.pos_detail_3),
    cType: t.conjugated_type && t.conjugated_type !== "*" ? t.conjugated_type : "*",
    cForm: t.conjugated_form && t.conjugated_form !== "*" ? t.conjugated_form : "*",
    lemma: t.basic_form || "",
    reading,
    pronunciation,
    isKnown: t.word_type === "KNOWN",
  };
}

export async function fetchKuromojiTokens(text: string): Promise<KuromojiToken[]> {
  if (!tokenizer) {
    throw new Error("kuromoji tokenizer is not initialized");
  }
  const raw = tokenizer.tokenize(text);
  return raw.map(mapIpadicTokenToKuromoji);
}

export function resolveReading(token: KuromojiToken): string | null {
  const tryP = token.pronunciation.trim();
  if (tryP && /^[ァ-ヾ]+$/.test(tryP)) return tryP;
  const tryR = token.reading.trim();
  if (tryR && /^[ァ-ヾ]+$/.test(tryR)) return tryR;
  if (KATAKANA_ONLY_PATTERN.test(token.surface)) return token.surface;
  return null;
}

export function isDigitOnlyToken(token: KuromojiToken): boolean {
  return /^[０-９0-9]+$/.test(token.surface);
}

export async function expandUnknownKatakanaTokens(
  tokens: KuromojiToken[],
  fetchFn: (text: string) => Promise<KuromojiToken[]>,
): Promise<KuromojiToken[]> {
  const out: KuromojiToken[] = [];
  for (const t of tokens) {
    if (
      !t.isKnown &&
      KATAKANA_ONLY_PATTERN.test(t.surface) &&
      t.surface.length >= 2
    ) {
      try {
        const sub = await fetchFn(t.surface);
        if (sub.length > 0 && sub.some((x) => x.isKnown)) {
          out.push(...sub);
          continue;
        }
      } catch {}
    }
    out.push(t);
  }
  return out;
}

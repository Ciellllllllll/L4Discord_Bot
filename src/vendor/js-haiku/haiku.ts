import { INFLECTIONAL_FORM_INDEX, PRONUNCIATION_INDEX } from "./constants.js";
import {
  morphFromKuromoji,
  readingYForFind,
  type KuromojiIpadicToken,
} from "./featureAdapter.js";
import { reWord, reKana } from "./regexes.js";
import type { MorphToken, Opt } from "./types.js";

function contains(c: string[], s: string): boolean {
  return c.some((cc) => cc === s);
}

function isEnd(c: string[]): boolean {
  if (c.length < 2) return true;
  let idx = PRONUNCIATION_INDEX;
  if (c[0] === "接頭辞") {
    if (idx >= 0 && contains(c, "御")) return false;
    return true;
  }
  if (c[1] === "非自立") {
    if (c[0] === "名詞") return true;
    if (c[0] === "動詞") return true;
    if (idx >= 0 && idx < c.length && c[idx] === "ノ") return true;
    return false;
  }
  idx = INFLECTIONAL_FORM_INDEX;
  if (idx >= 0 && idx < c.length) {
    if (c[idx] === "未然形") return false;
  }
  return true;
}

function isIgnore(c: string[]): boolean {
  return (
    c.length > 1 &&
    (c[0] === "空白" ||
      c[0] === "補助記号" ||
      (c[0] === "記号" && c[1] === "空白"))
  );
}

function isWord(c: string[]): boolean {
  if (c.length < 2) return false;
  if (c[0] !== "名詞" && c[1] === "非自立") return false;
  for (const f of [
    "名詞",
    "形容詞",
    "形容動詞",
    "副詞",
    "連体詞",
    "接続詞",
    "感動詞",
    "接頭詞",
    "フィラー",
  ]) {
    if (f === c[0] && c[1] !== "接尾") return true;
  }
  if (c[0] === "接頭辞" || (c[0] === "接続詞" && c[1] === "名詞接続")) {
    return false;
  }
  if (c[0] === "形状詞" && c[1] !== "助動詞語幹") return true;
  if (c[0] === "代名詞") return true;
  if (c[0] === "記号" && c[1] === "一般") return true;
  if (
    c[0] === "助詞" &&
    c[1] !== "副助詞" &&
    c[1] !== "準体助詞" &&
    c[1] !== "終助詞" &&
    c[1] !== "係助詞" &&
    c[1] !== "格助詞" &&
    c[1] !== "接続助詞" &&
    c[1] !== "連体化" &&
    c[1] !== "副助詞／並立助詞／終助詞"
  ) {
    return true;
  }
  if (c[0] === "動詞" && c[1] !== "接尾" && c[1] !== "非自立") return true;
  if (c[0] === "カスタム人名" || c[0] === "カスタム名詞") return true;
  if (c[0] === "助動詞") {
    const p = c[PRONUNCIATION_INDEX] ?? "*";
    if (p === "ズン" || p === "ズンズン") return true;
  }
  return false;
}

export function countChars(s: string): number {
  const reIgnoreChar = /[ァィゥェォャュョ]/g;
  return [...s.replace(reIgnoreChar, "")].length;
}

function debugLine(opt: Opt | undefined, c: string[], y: string): void {
  if (!opt?.debug) return;
  const line = JSON.stringify({ features: c, y });
  if (opt.debugWriter) opt.debugWriter(line + "\n");
  else process.stderr.write(line + "\n");
}

function mergeKatakanaMorphs(tokens: MorphToken[]): void {
  for (let i = 0; i < tokens.length; i++) {
    if (!reKana.test(tokens[i]!.surface)) continue;
    let surface = tokens[i]!.surface;
    let j = i + 1;
    for (; j < tokens.length; j++) {
      if (reKana.test(tokens[j]!.surface)) surface += tokens[j]!.surface;
      else break;
    }
    if (j === i + 1) continue;
    tokens[i]!.surface = surface;
    for (let k = 0; k < j - i; k++) {
      if (i + 1 + k < tokens.length && j + k < tokens.length) {
        tokens[i + 1 + k] = tokens[j + k]!;
      }
    }
    tokens.length = tokens.length - (j - i) + 1;
    i--;
  }
}

export function findWithOptMorphs(
  morphs: MorphToken[],
  rule: number[],
  opt?: Opt
): string[] {
  if (rule.length === 0) return [];
  const tokens = morphs
    .filter((t) => !isIgnore(t.features))
    .map((t) => ({ surface: t.surface, features: [...t.features] }));
  mergeKatakanaMorphs(tokens);

  const ret: string[] = [];
  let pos = 0;
  const r = [...rule];
  let sentence = "";
  let start = 0;
  let ambigous = 0;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const c = tok.features;
    if (c.length < 7) continue;

    const y = readingYForFind(tok.surface, c);
    debugLine(opt, c, y);
    if (!reWord.test(y)) {
      if (y === "、") continue;
      pos = 0;
      ambigous = 0;
      sentence = "";
      for (let k = 0; k < rule.length; k++) r[k] = rule[k]!;
      continue;
    }
    if (pos >= rule.length || (r[pos] === rule[pos] && !isWord(c))) {
      pos = 0;
      ambigous = 0;
      sentence = "";
      for (let k = 0; k < rule.length; k++) r[k] = rule[k]!;
      continue;
    }
    ambigous += (y.match(/ッ/g) ?? []).length + (y.match(/ー/g) ?? []).length;
    const n = countChars(y);
    r[pos]! -= n;
    sentence += tok.surface;
    if (r[pos]! >= 0 && (r[pos] === 0 || r[pos]! + ambigous === 0)) {
      pos++;
      if (pos === rule.length) {
        if (isEnd(c)) ret.push(sentence);
        start = i + 1;
        pos = 0;
        ambigous = 0;
        sentence = "";
        for (let k = 0; k < rule.length; k++) r[k] = rule[k]!;
        continue;
      }
      sentence += " ";
    } else if (r[pos]! < 0) {
      i = start + 1;
      start++;
      pos = 0;
      ambigous = 0;
      sentence = "";
      for (let k = 0; k < rule.length; k++) r[k] = rule[k]!;
    }
  }
  return ret;
}

export function morphsFromKuromojiTokens(raw: KuromojiIpadicToken[]): MorphToken[] {
  return raw.map((t) => morphFromKuromoji(t));
}

export function mergeDeHaMorphs(morphs: MorphToken[]): MorphToken[] {
  const out: MorphToken[] = [];
  for (let i = 0; i < morphs.length; i++) {
    const a = morphs[i]!;
    const b = morphs[i + 1];
    if (
      a.surface === "で" &&
      b?.surface === "は" &&
      a.features[0] === "助詞" &&
      b.features[0] === "助詞"
    ) {
      const f = [...a.features];
      const da = a.features[PRONUNCIATION_INDEX] ?? "*";
      const wb = b.features[PRONUNCIATION_INDEX] ?? "*";
      if (da !== "*" && wb !== "*") f[PRONUNCIATION_INDEX] = `${da}${wb}`;
      out.push({ surface: "では", features: f });
      i++;
    } else out.push(a);
  }
  return out;
}

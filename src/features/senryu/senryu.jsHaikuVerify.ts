import {
  findWithOptMorphs,
  mergeDeHaMorphs,
  morphsFromKuromojiTokens,
} from "../../vendor/js-haiku/haiku.js";
import type { KuromojiIpadicToken } from "../../vendor/js-haiku/featureAdapter.js";
import type { KuromojiToken, SenryuCandidate } from "./senryu.types.js";

const RULE_575 = [5, 7, 5] as const;

function kuromojiTokenToIpadic(t: KuromojiToken): KuromojiIpadicToken {
  const u = (s: string) => (s === "*" ? "" : s);
  return {
    surface_form: t.surface,
    pos: u(t.pos[0]!),
    pos_detail_1: u(t.pos[1]!),
    pos_detail_2: u(t.pos[2]!),
    pos_detail_3: u(t.pos[3]!),
    conjugated_type: t.cType === "*" ? "" : t.cType,
    conjugated_form: t.cForm === "*" ? "" : t.cForm,
    basic_form: t.lemma,
    reading: t.reading || undefined,
    pronunciation: t.pronunciation || undefined,
  };
}

/** 表示用の句区切りを揃えて比較する（js-haiku の find は句の間に半角スペースを挟む） */
function normalizeSenryuFormatted(s: string): string {
  return s.replace(/\s+/gu, " ").trim();
}

/** 空白無しでも一致すればよい（表記ゆれの保険） */
function compactSurface(s: string): string {
  return s.replace(/\s+/gu, "");
}

/**
 * BOT が選んだ候補が、同じ kuromoji トークン列から組み立てた morph に対する
 * go-haiku 相当の find(5-7-5) 結果のいずれかと一致するか。
 */
export function senryuCandidateMatchesJsHaiku575(
  expandedTokens: KuromojiToken[],
  candidate: SenryuCandidate,
): boolean {
  const raw = expandedTokens.map(kuromojiTokenToIpadic);
  const morphs = mergeDeHaMorphs(morphsFromKuromojiTokens(raw));
  const hits = findWithOptMorphs(morphs, [...RULE_575]);
  const want = normalizeSenryuFormatted(candidate.formatted);
  const wantCompact = compactSurface(want);
  for (const h of hits) {
    const n = normalizeSenryuFormatted(h);
    if (n === want || compactSurface(n) === wantCompact) return true;
  }
  return false;
}

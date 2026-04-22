import { MIN_FEATURES_LENGTH, PRONUNCIATION_INDEX } from "./constants.js";
import type { MorphToken } from "./types.js";
import { reKana } from "./regexes.js";

export interface KuromojiIpadicToken {
  surface_form: string;
  pos: string;
  pos_detail_1: string;
  pos_detail_2: string;
  pos_detail_3: string;
  conjugated_type: string;
  conjugated_form: string;
  basic_form: string;
  reading?: string;
  pronunciation?: string;
}

function z(s: string | undefined): string {
  if (s == null || s === "") return "*";
  return s;
}

export function morphFromKuromoji(token: KuromojiIpadicToken): MorphToken {
  const features: string[] = [
    z(token.pos),
    z(token.pos_detail_1),
    z(token.pos_detail_2),
    z(token.pos_detail_3),
    z(token.conjugated_type),
    z(token.conjugated_form),
    z(token.basic_form),
    z(token.reading),
    z(token.pronunciation),
  ];
  while (features.length < MIN_FEATURES_LENGTH) {
    features.push("*");
  }
  return { surface: token.surface_form, features };
}

export function readingYForMatch(surface: string, c: string[]): string {
  if (reKana.test(surface)) return surface;
  if (c.length === 3) return c[2] ?? surface;
  if (PRONUNCIATION_INDEX >= 0 && PRONUNCIATION_INDEX < c.length) {
    const y = c[PRONUNCIATION_INDEX];
    if (y && y !== "*") return y;
  }
  return surface;
}

export function readingYForFind(surface: string, c: string[]): string {
  if (reKana.test(surface)) return surface;
  if (PRONUNCIATION_INDEX >= 0 && PRONUNCIATION_INDEX < c.length) {
    const y = c[PRONUNCIATION_INDEX];
    if (y && y !== "*") return y;
  }
  return surface;
}

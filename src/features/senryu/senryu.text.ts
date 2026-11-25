import type { Message } from "discord.js";
import type { SenryuCandidate } from "./senryu.types.js";

export const DISCORD_TOKEN_PATTERN =
  /<@!?\d+>|<#\d+>|<@&\d+>|<a?:\w+:\d+>|https?:\/\/\S+/;

export const SPOILER_PATTERN = /\|\|.+?\|\|/;

export const KATAKANA_ONLY_PATTERN = /^[ァ-ヾ]+$/;

const SMALL_KANA = new Set(["ァ", "ィ", "ゥ", "ェ", "ォ", "ャ", "ュ", "ョ"]);

export function containsDiscordTokens(content: string): boolean {
  return DISCORD_TOKEN_PATTERN.test(content);
}

export function containsSpoiler(content: string): boolean {
  return SPOILER_PATTERN.test(content);
}

export function stripSpoilerMarkers(content: string): string {
  let s = content;
  let prev = "";
  while (s !== prev) {
    prev = s;
    s = s.replace(/\|\|(.+?)\|\|/g, "$1");
  }
  return s;
}

export function toFullWidthKana(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const code = c.codePointAt(0)!;
    if (code >= 0xff61 && code <= 0xff9f) {
      out += String.fromCodePoint(code - 0xff61 + 0x30a1);
    } else {
      out += c;
    }
  }
  return out;
}

export function normalizeSenryuText(content: string): string {
  const nfc = content.normalize("NFC");
  const kana = toFullWidthKana(nfc);
  // kuromoji が読み無しの空白トークンを出して 5-7-5 検出が途切れるのを防ぐため、句読点・括弧・空白を解析前に除去する。
  return kana.replace(/[\p{P}\p{Z}\p{Cf}]+/gu, "");
}

export function countAmbiguousInReading(reading: string): number {
  let n = 0;
  for (const ch of reading) {
    if (ch === "ッ" || ch === "ー") n += 1;
  }
  return n;
}

// ッ・ーは曖昧モーラとして別計上するため除外する。
export function countMora(reading: string): number {
  let n = 0;
  for (const ch of reading) {
    if (SMALL_KANA.has(ch)) continue;
    if (ch === "ッ" || ch === "ー") continue;
    if (/[ァ-ヾ]/.test(ch)) n += 1;
  }
  return n;
}

export async function replySenryu(
  message: Message,
  candidate: SenryuCandidate,
  spoiler: boolean,
): Promise<void> {
  const lines = spoiler
    ? [`川柳を検出しました！`, `||「${candidate.formatted}」||`]
    : [`川柳を検出しました！`, `「${candidate.formatted}」`];
  await message.reply({ content: lines.join("\n"), allowedMentions: { parse: [] } });
}

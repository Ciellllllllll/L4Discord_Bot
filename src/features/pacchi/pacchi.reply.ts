import type { PacchiRate } from "./pacchi.types.js";
import { sanitizeForReply } from "./pacchi.filters.js";

export const RATE_CONFIG: Record<PacchiRate, { chance: number; cooldownSeconds: number }> = {
  silent: { chance: 0, cooldownSeconds: 60 },
  low: { chance: 0.02, cooldownSeconds: 120 },
  normal: { chance: 0.05, cooldownSeconds: 60 },
  high: { chance: 0.1, cooldownSeconds: 30 },
  unlimited: { chance: 1, cooldownSeconds: 0 },
};

const BASE_REPLIES = [
  "なに",
  "呼んだ？",
  "ぱっちぃはいる",
  "ぱっちぃは見ている",
  "今ちょっと考えてた",
  "それはそう",
  "なるほど",
  "わかるかもしれない",
  "むずい",
  "たしかに",
];

const WORD_REPLIES = [
  "{word} かもしれない",
  "つまり {word} ということ",
  "ぱっちぃは {word} を覚えた",
  "なんか {word} っぽい",
  "{word} の話？",
  "それは {word}",
  "{word}、わからん",
  "{word} は大事",
];

export function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

export function buildPacchiReply(word: string | null, preferWord = false): string {
  const safe = word ? sanitizeForReply(word) : null;
  if (safe && (preferWord || Math.random() < 0.45)) {
    return pick(WORD_REPLIES).replace("{word}", safe);
  }
  return pick(BASE_REPLIES);
}

export function appendRandomEmojiAtEnd(content: string, emoji: string | null): string {
  if (!emoji || Math.random() >= 0.35) return content;
  return `${content.trimEnd()} ${emoji}`;
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}時間${m}分`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

export function buildPoem(pattern: string, words: string[]): string | null {
  if (!/^[1-9][0-9]*$/.test(pattern)) return null;
  if (pattern.length > 5) return null;
  const safeWords = words.map((w) => sanitizeForReply(w)).filter((w): w is string => Boolean(w));
  const fallback = ["月あかり", "静かな朝", "風が吹く", "ぱっちぃ", "それはそう"];
  const source = safeWords.length > 0 ? safeWords : fallback;
  return [...pattern].map((digit, index) => {
    const word = source[(index + Math.floor(Math.random() * source.length)) % source.length] ?? "ぱっちぃ";
    return `${word} ${digit}`;
  }).join("\n");
}

export function janken(userHand: string): string {
  const hands = ["グー", "チョキ", "パー"] as const;
  const bot = pick(hands);
  if (bot === userHand) return `ぱっちぃは${bot}。あいこ`;
  const win =
    (bot === "グー" && userHand === "チョキ") ||
    (bot === "チョキ" && userHand === "パー") ||
    (bot === "パー" && userHand === "グー");
  return `ぱっちぃは${bot}。${win ? "ぱっちぃの勝ち" : "ぱっちぃの負け"}`;
}

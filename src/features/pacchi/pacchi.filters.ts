const BLOCKED_WORDS = [
  "死ね",
  "殺す",
  "ばか",
  "バカ",
  "アホ",
  "fuck",
  "shit",
];

const TOKEN_PATTERNS = [
  /https?:\/\/\S+/i,
  /discord\.gg\/\S+/i,
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  /(?:\+?\d[\d -]{8,}\d)/,
  /[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}/,
  /(?:api[_-]?key|token|password|secret)\s*[:=]/i,
  /@everyone|@here/,
  /<@!?&?\d+>|<#\d+>|<a?:\w+:\d+>/,
  /```/,
];

export function normalizeText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

export function containsUnsafeText(input: string): boolean {
  const text = normalizeText(input);
  if (!text) return true;
  if (TOKEN_PATTERNS.some((re) => re.test(text))) return true;
  return BLOCKED_WORDS.some((word) => text.toLowerCase().includes(word.toLowerCase()));
}

export function isLearnableMessage(content: string, _hasAttachments: boolean): boolean {
  const text = normalizeText(content);
  if (!text) return false;
  if (text.startsWith("!") || text.startsWith("/")) return false;
  if (text.length <= 1 || text.length >= 200) return false;
  if (/^https?:\/\/\S+$/i.test(text)) return false;
  if (/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u.test(text)) return false;
  if (containsUnsafeText(text)) return false;
  return /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}A-Za-z0-9]/u.test(text);
}

export function sanitizeForReply(input: string): string | null {
  const text = normalizeText(input).slice(0, 40);
  if (!text || containsUnsafeText(text)) return null;
  if (/https?:\/\//i.test(text) || /discord\.gg/i.test(text)) return null;
  return text.replace(/[@`]/g, "");
}

export function extractWords(content: string): string[] {
  const text = normalizeText(content);
  const matches = text.match(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}A-Za-z0-9]{2,20}/gu) ?? [];
  const out = new Set<string>();
  for (const raw of matches) {
    const word = sanitizeForReply(raw);
    if (!word) continue;
    if (/^(ぱっちぃ|おはよう|おやすみ|ってなんやねん)$/.test(word)) continue;
    out.add(word);
    if (out.size >= 8) break;
  }
  return [...out];
}

export function extractPhrase(content: string): string | null {
  const text = normalizeText(content);
  if (text.length < 4 || text.length > 60) return null;
  return sanitizeForReply(text);
}

export function parseLimit(input: string | undefined, fallback: number, max: number): number {
  const n = input ? Number.parseInt(input, 10) : fallback;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

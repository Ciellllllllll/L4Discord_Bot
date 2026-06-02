import { normalizeText, sanitizeForReply } from "./pacchi.filters.js";

export function extractJanken(content: string): "グー" | "チョキ" | "パー" | null {
  const text = normalizeText(content);
  if (text === "グー" || text === "チョキ" || text === "パー") return text;
  if (text.includes("ぱっちぃ")) {
    if (text.includes("グー")) return "グー";
    if (text.includes("チョキ")) return "チョキ";
    if (text.includes("パー")) return "パー";
  }
  return null;
}

export function extractTermQuestion(content: string): string | null {
  const match = normalizeText(content).match(/^(.{1,40})ってなんやねん$/);
  if (!match) return null;
  return sanitizeForReply(match[1] ?? "");
}

export function extractNaturalPoem(content: string): string | null {
  const text = normalizeText(content);
  const match = text.match(/^ぱっちぃ\s+(?:詩\s+)?([1-9][0-9]{0,4})$/);
  return match?.[1] ?? null;
}

export function isWorkStart(content: string): boolean {
  return normalizeText(content) === "ぱっちぃ 日報開始";
}

export function isWorkEnd(content: string): boolean {
  return normalizeText(content) === "ぱっちぃ 日報終了";
}

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export function sanitizeAiText(text: string): string {
  return String(text || "")
    .trim()
    .replace(/@everyone/g, "@\u200beveryone")
    .replace(/@here/g, "@\u200bhere")
    .replace(/<@(?:!?|&)\d+>/g, (match) => match.replace("<@", "<@\u200b"));
}

const urlPattern = /https?:\/\/\S+/i;
const mentionPattern = /<[@#][!&]?\d+>|<@&\d+>/;
const customEmojiPattern = /<a?:[A-Za-z0-9_~]+:\d+>/;
const codePattern = /```|`[^`]+`/s;
const personalInfoPattern = /\b\d{3}-\d{4}|\b\d{2,4}-\d{2,4}-\d{3,4}\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const symbolOnlyPattern = /^[\p{P}\p{S}\s]+$/u;
const bannedWords = ["草"];

export function isUnsafeForPacchiLearning(content: string): boolean {
  const text = content.trim();
  if (!text) return true;
  if (text.length > 120) return true;
  if (urlPattern.test(text)) return true;
  if (mentionPattern.test(text)) return true;
  if (customEmojiPattern.test(text)) return true;
  if (codePattern.test(text)) return true;
  if (personalInfoPattern.test(text)) return true;
  if (symbolOnlyPattern.test(text)) return true;
  return bannedWords.some((word) => text.includes(word));
}

export function isSafePacchiReply(content: string): boolean {
  const text = content.trim();
  if (!text) return false;
  if (text.length > 160) return false;
  if (urlPattern.test(text)) return false;
  if (mentionPattern.test(text)) return false;
  if (personalInfoPattern.test(text)) return false;
  if (symbolOnlyPattern.test(text)) return false;
  if (/(.)\1{8,}/u.test(text)) return false;
  return !bannedWords.some((word) => text.includes(word));
}

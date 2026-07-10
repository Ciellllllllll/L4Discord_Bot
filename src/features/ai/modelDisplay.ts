export function sanitizeAiModelName(model: string): string {
  return String(model || "")
    .replace(/[^\p{L}\p{N}._:/+-]+/gu, " ")
    .trim()
    .slice(0, 120) || "不明";
}

export const DEFAULT_TRIM_TAIL_CHARS = ".,!?;:)]}>,、。」』）";
export const QUOTED_TRIM_TAIL_CHARS = `${DEFAULT_TRIM_TAIL_CHARS}"'`;
export const MARKDOWN_TRIM_TAIL_CHARS = `${DEFAULT_TRIM_TAIL_CHARS}*_~\`|`;
export const BARE_URL_BOUNDARY_CHARS = new Set(["<", "(", "[", "{", "\"", "'"]);

export function stripUrlTail(raw: string, tailChars = DEFAULT_TRIM_TAIL_CHARS): string {
  let out = String(raw || "").trim();
  while (out && tailChars.includes(out[out.length - 1]!)) {
    out = out.slice(0, -1);
  }
  return out;
}

export function ensureScheme(raw: string): string {
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

export function hostWithoutWww(host: string): string {
  const normalized = host.trim().toLowerCase();
  return normalized.startsWith("www.") ? normalized.slice(4) : normalized;
}

export function hasBareUrlBoundary(content: string, index: number, raw: string): boolean {
  if (/^https?:\/\//i.test(raw) || index <= 0) return true;
  const previous = content[index - 1] ?? "";
  return /\s/u.test(previous) || previous === "\u3000" || BARE_URL_BOUNDARY_CHARS.has(previous);
}

export function safeHttpsUrl(
  value: unknown,
  options: { base?: string; allowCredentials?: boolean } = {},
): string | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  try {
    const parsed = options.base ? new URL(raw, options.base) : new URL(raw);
    if (parsed.protocol !== "https:") return undefined;
    if (!options.allowCredentials && (parsed.username || parsed.password)) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function compactText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

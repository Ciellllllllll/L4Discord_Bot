import { type Guild, type GuildEmoji } from "discord.js";
import type { AppConfig } from "../../core/config.js";

// リアクションロールの値オブジェクトと文字列パース。

export type ReactionRoleLine = { roleId: string; label: string; emoji: string | null };

export type ReactionRoleEntry = {
  entryId: string;
  channelId: string;
  messageId: string | null;
  title: string;
  description: string;
  roles: ReactionRoleLine[];
};

export function getReactionRoleUiChannelId(config: AppConfig): string | undefined {
  const raw = (config.REACTION_ROLE_UI_CHANNEL_ID || config.REACTION_ROLE_OUTPUT_CHANNEL_ID)?.trim();
  return raw && /^\d+$/.test(raw) ? raw : undefined;
}

export function normalizeSnowflake(value: unknown): string | null {
  const id = String(value ?? "").trim();
  return /^\d+$/.test(id) ? id : null;
}

export function truncateText(value: unknown, max = 100): string {
  const src = String(value ?? "").trim();
  if (!src) return "";
  return src.length <= max ? src : `${src.slice(0, Math.max(1, max - 1))}…`;
}

export function extractChannelId(input: unknown): string | null {
  const src = String(input ?? "").trim();
  if (!src) return null;
  const mention = src.match(/^<#(\d+)>$/);
  if (mention?.[1]) return mention[1];
  const plain = normalizeSnowflake(src);
  if (plain) return plain;
  const loose = src.match(/(\d{17,20})/);
  return loose?.[1] ?? null;
}

export function parseRoleLines(text: unknown): ReactionRoleLine[] {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  const out: ReactionRoleLine[] = [];
  for (const line of lines) {
    const parts = line.split("|").map((x) => x.trim());
    if (parts.length < 2) continue;
    const roleId = parts[0]!.replace(/[<@&>]/g, "");
    const label = parts[1]!;
    const emoji = parts[2] || null;
    if (!/^\d+$/.test(roleId) || !label) continue;
    out.push({ roleId, label: label.slice(0, 80), emoji: emoji ? emoji.slice(0, 100) : null });
  }
  return out.slice(0, 5);
}

function normalizeEmojiName(input: string): string {
  const src = input.trim();
  const colon = src.match(/^:([^:\s]+):$/);
  return colon?.[1] ?? src;
}

function extractCustomEmojiId(input: string): string | null {
  const match = input.trim().match(/^<a?:[A-Za-z0-9_]+:(\d{17,20})>$/);
  return match?.[1] ?? null;
}

function needsGuildEmojiLookup(input: string | null): boolean {
  const src = String(input ?? "").trim();
  if (!src) return false;
  if (extractCustomEmojiId(src)) return true;
  if (/^\d{17,20}$/.test(src)) return true;
  return /^[A-Za-z0-9_]+$/.test(normalizeEmojiName(src));
}

async function fetchGuildEmojiMap(guild: Guild): Promise<Map<string, GuildEmoji>> {
  const emojis = await guild.emojis.fetch();
  return new Map(emojis.map((emoji) => [emoji.id, emoji]));
}

function resolveGuildEmojiInput(
  input: string | null,
  emojiMap: Map<string, GuildEmoji> | undefined,
): string | null {
  const src = String(input ?? "").trim();
  if (!src) return null;

  const id = extractCustomEmojiId(src) ?? (src.match(/^\d{17,20}$/) ? src : null);
  if (id) {
    return emojiMap?.has(id) ? id : null;
  }

  const lookupName = normalizeEmojiName(src);
  if (/^[A-Za-z0-9_]+$/.test(lookupName)) {
    const emoji = [...(emojiMap?.values() ?? [])].find((item) => item.name === lookupName);
    return emoji?.id ?? null;
  }

  return src;
}

export async function normalizeRoleLineEmojis(
  guild: Guild,
  roles: ReactionRoleLine[],
): Promise<{ roles: ReactionRoleLine[]; error: string | null }> {
  let emojiMap: Map<string, GuildEmoji> | undefined;
  if (roles.some((role) => needsGuildEmojiLookup(role.emoji))) {
    const fetched = await fetchGuildEmojiMap(guild).catch(() => null);
    if (!fetched) {
      return { roles, error: "サーバー絵文字の取得に失敗しました。Bot の権限を確認してください。" };
    }
    emojiMap = fetched;
  }

  const normalized: ReactionRoleLine[] = [];
  for (const role of roles) {
    const emoji = resolveGuildEmojiInput(role.emoji, emojiMap);
    if (role.emoji && !emoji) {
      return {
        roles,
        error: `絵文字がこのサーバーに見つかりません: ${role.emoji}`,
      };
    }
    normalized.push({ ...role, emoji });
  }
  return { roles: normalized, error: null };
}

export function formatRolesForInput(roles: ReactionRoleLine[]): string {
  return roles
    .map((item) => [item.roleId, item.label, item.emoji || ""].join("|").replace(/\|$/, ""))
    .join("\n");
}

export function makeEntryId(): string {
  return `rr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function parseRolesJson(raw: string): ReactionRoleLine[] {
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const o = item as Record<string, unknown>;
        const roleId = normalizeSnowflake(o.roleId);
        const label = truncateText(o.label ?? "", 80);
        const emoji = o.emoji ? truncateText(o.emoji, 100) : null;
        if (!roleId || !label) return null;
        return { roleId, label, emoji: emoji || null } satisfies ReactionRoleLine;
      })
      .filter(Boolean) as ReactionRoleLine[];
  } catch {
    return [];
  }
}

export function rowToEntry(row: {
  entry_id: string;
  channel_id: string;
  message_id: string | null;
  title: string;
  description: string;
  roles_json: string;
}): ReactionRoleEntry {
  return {
    entryId: row.entry_id,
    channelId: row.channel_id,
    messageId: row.message_id,
    title: row.title,
    description: row.description,
    roles: parseRolesJson(row.roles_json).slice(0, 5),
  };
}

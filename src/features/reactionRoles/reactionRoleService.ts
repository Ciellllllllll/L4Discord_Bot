import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type Guild,
  type Message,
} from "discord.js";
import type { Kysely } from "kysely";
import type { BotContext } from "../../bot/context.js";
import type { AppConfig } from "../../core/config.js";
import type { Database } from "../../core/db/types.js";
import { sqliteTimestamp } from "../../core/db/sqliteTimestamp.js";
import { getPermanentUiVersion } from "../../core/releaseVersions.js";
import { PANEL_KIND_REACTION_ROLE_ADMIN } from "../panels/constants.js";
import { tryDeleteBotPanelMessage } from "../panels/panelDiscordOps.js";
import { ensurePanelMessageRow, savePanelMessageRow } from "../panels/panelMessageStore.js";
import {
  ADMIN_CREATE_BUTTON_ID,
  ADMIN_DELETE_BUTTON_ID,
  ADMIN_EDIT_BUTTON_ID,
  TOGGLE_PREFIX,
} from "./reactionRoleConstants.js";

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
    out.push({ roleId, label: label.slice(0, 80), emoji: emoji ? emoji.slice(0, 20) : null });
  }
  return out.slice(0, 5);
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
        const emoji = o.emoji ? truncateText(o.emoji, 20) : null;
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

export async function loadEntriesForGuild(db: Kysely<Database>, guildId: string): Promise<ReactionRoleEntry[]> {
  const rows = await db
    .selectFrom("reaction_role_entries")
    .select(["entry_id", "channel_id", "message_id", "title", "description", "roles_json"])
    .where("guild_id", "=", guildId)
    .execute();
  return rows.map(rowToEntry);
}

export async function getEntryByEntryId(
  db: Kysely<Database>,
  guildId: string,
  entryId: string,
): Promise<ReactionRoleEntry | null> {
  const row = await db
    .selectFrom("reaction_role_entries")
    .select(["entry_id", "channel_id", "message_id", "title", "description", "roles_json"])
    .where("guild_id", "=", guildId)
    .where("entry_id", "=", entryId)
    .executeTakeFirst();
  return row ? rowToEntry(row) : null;
}

export function buildEntryRows(entry: ReactionRoleEntry): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  const buttons = entry.roles.map((item) => {
    const button = new ButtonBuilder()
      .setCustomId(`${TOGGLE_PREFIX}${entry.entryId}:${item.roleId}`)
      .setLabel(item.label)
      .setStyle(ButtonStyle.Secondary);
    if (item.emoji) {
      try {
        button.setEmoji(item.emoji);
      } catch {}
    }
    return button;
  });
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5)));
  }
  return rows;
}

export function buildEntryEmbed(entry: ReactionRoleEntry): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(entry.title || "Reaction Role")
    .setDescription(entry.description || "ボタンを押してロールを付与/解除します。")
    .setColor(0x8e44ad);
}

export function buildAdminEmbed(uiChannelMention: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("リアクションロール管理パネル")
    .setDescription(
      [
        "作成/編集/削除をこのパネルから行えます。",
        "",
        "roles の形式: `roleId|label|emoji` を1行ずつ記述 (最大5件まで)",
        "例: `123456789012345678|お知らせ|📢`",
        "",
        `管理パネルチャンネル: ${uiChannelMention}`,
      ].join("\n"),
    )
    .setColor(0x5865f2);
}

export function buildAdminRows(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(ADMIN_CREATE_BUTTON_ID).setLabel("作成").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(ADMIN_EDIT_BUTTON_ID).setLabel("編集").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(ADMIN_DELETE_BUTTON_ID).setLabel("削除").setStyle(ButtonStyle.Danger),
    ),
  ];
}

function messageHasCustomId(message: Message, customId: string): boolean {
  for (const row of message.components) {
    if (!("components" in row) || !row.components) continue;
    for (const c of row.components) {
      if ("customId" in c && c.customId === customId) return true;
    }
  }
  return false;
}

function messageHasEntryButton(message: Message, entryId: string, botUserId: string): boolean {
  if (message.author?.id !== botUserId) return false;
  const prefix = `${TOGGLE_PREFIX}${entryId}:`;
  for (const row of message.components) {
    if (!("components" in row) || !row.components) continue;
    for (const c of row.components) {
      if ("customId" in c && typeof c.customId === "string" && c.customId.startsWith(prefix)) return true;
    }
  }
  return false;
}

async function resolveTextChannel(guild: Guild, channelId: string) {
  let channel = guild.channels.cache.get(channelId) ?? undefined;
  if (!channel) {
    channel = (await guild.channels.fetch(channelId).catch(() => null)) ?? undefined;
  }
  if (!channel?.isTextBased()) return null;
  return channel;
}

// 公開メッセージを送信または更新し、最終 message ID を返す

export async function sendOrUpdateEntryMessage(
  ctx: BotContext,
  guild: Guild,
  entry: ReactionRoleEntry,
): Promise<string> {
  const channel = await resolveTextChannel(guild, entry.channelId);
  if (!channel) {
    throw new Error(`channel not found: ${entry.channelId}`);
  }
  const payload = {
    embeds: [buildEntryEmbed(entry)],
    components: buildEntryRows(entry),
  };
  const botId = ctx.client.user?.id;

  if (entry.messageId) {
    const old = await channel.messages.fetch(entry.messageId).catch(() => null);
    if (old && old.author?.id === botId) {
      await old.edit(payload);
      return old.id;
    }
  }

  const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (recent && botId) {
    const existing = recent.find((m) => messageHasEntryButton(m, entry.entryId, botId));
    if (existing) {
      await existing.edit(payload).catch(() => undefined);
      return existing.id;
    }
  }

  const sent = await channel.send(payload);
  return sent.id;
}

export async function deleteEntryDiscordMessage(ctx: BotContext, guild: Guild, entry: ReactionRoleEntry): Promise<void> {
  if (!entry.messageId) return;
  const channel = await resolveTextChannel(guild, entry.channelId);
  if (!channel) return;
  const msg = await channel.messages.fetch(entry.messageId).catch(() => null);
  if (msg && msg.author?.id === ctx.client.user?.id) {
    await msg.delete().catch(() => undefined);
  }
}

export async function insertEntry(
  db: Kysely<Database>,
  guildId: string,
  entry: ReactionRoleEntry,
): Promise<void> {
  await db
    .insertInto("reaction_role_entries")
    .values({
      id: randomUUID(),
      guild_id: guildId,
      entry_id: entry.entryId,
      channel_id: entry.channelId,
      message_id: entry.messageId,
      title: entry.title,
      description: entry.description,
      roles_json: JSON.stringify(entry.roles),
      created_at: sqliteTimestamp() as unknown as Date,
    })
    .execute();
}

export async function updateEntryRow(
  db: Kysely<Database>,
  guildId: string,
  entry: ReactionRoleEntry,
): Promise<void> {
  await db
    .updateTable("reaction_role_entries")
    .set({
      channel_id: entry.channelId,
      message_id: entry.messageId,
      title: entry.title,
      description: entry.description,
      roles_json: JSON.stringify(entry.roles),
    })
    .where("guild_id", "=", guildId)
    .where("entry_id", "=", entry.entryId)
    .execute();
}

export async function deleteEntryRow(db: Kysely<Database>, guildId: string, entryId: string): Promise<void> {
  await db.deleteFrom("reaction_role_entries").where("guild_id", "=", guildId).where("entry_id", "=", entryId).execute();
}

export async function setEntryMessageId(
  db: Kysely<Database>,
  guildId: string,
  entryId: string,
  messageId: string,
  channelId: string,
): Promise<void> {
  await db
    .updateTable("reaction_role_entries")
    .set({ message_id: messageId, channel_id: channelId })
    .where("guild_id", "=", guildId)
    .where("entry_id", "=", entryId)
    .execute();
}

export async function reconcileReactionRoleAdminPanel(
  ctx: BotContext,
  guild: Guild,
  channelId: string,
): Promise<void> {
  const kind = PANEL_KIND_REACTION_ROLE_ADMIN;
  const codeVer = getPermanentUiVersion(kind);
  let row = await ensurePanelMessageRow(ctx, guild.id, kind, channelId);

  if (row.channel_id !== channelId) {
    if (row.message_id) {
      await tryDeleteBotPanelMessage(ctx, guild, row.channel_id, row.message_id);
    }
    await savePanelMessageRow(ctx, row.id, channelId, "", { ...row.data, status: "pending" });
    row = { ...row, channel_id: channelId, message_id: "", data: { ...row.data, status: "pending" } };
  }

  const ch = await guild.channels.fetch(channelId).catch(() => null);
  if (!ch?.isTextBased()) {
    ctx.log.warn({ channelId }, "reaction role admin channel missing or not text");
    await savePanelMessageRow(ctx, row.id, channelId, row.message_id, {
      ...row.data,
      status: "error",
      last_error: "channel_missing",
    });
    return;
  }

  const embed = buildAdminEmbed(`<#${channelId}>`);
  const components = buildAdminRows();
  const botId = ctx.client.user?.id ?? "";

  if (row.message_id) {
    const msg = await ch.messages.fetch(row.message_id).catch(() => null);
    if (msg && msg.author?.id === botId && messageHasCustomId(msg, ADMIN_CREATE_BUTTON_ID)) {
      if (row.data.ui_version === codeVer) {
        return;
      }
      try {
        await msg.edit({ embeds: [embed], components });
        await savePanelMessageRow(ctx, row.id, channelId, msg.id, {
          ui_version: codeVer,
          status: "sent",
          last_sent_at: new Date().toISOString(),
        });
      } catch (e) {
        ctx.log.error({ err: e, kind }, "reaction role admin panel edit failed");
      }
      return;
    }
  }

  const recent = await ch.messages.fetch({ limit: 50 }).catch(() => null);
  if (recent && botId) {
    const existing = recent.find(
      (m) => m.author?.id === botId && messageHasCustomId(m, ADMIN_CREATE_BUTTON_ID),
    );
    if (existing) {
      try {
        if (row.data.ui_version !== codeVer) {
          await existing.edit({ embeds: [embed], components });
        }
        await savePanelMessageRow(ctx, row.id, channelId, existing.id, {
          ui_version: codeVer,
          status: "sent",
          last_sent_at: new Date().toISOString(),
        });
      } catch (e) {
        ctx.log.error({ err: e }, "reaction role admin panel reconnect edit failed");
      }
      ctx.log.info({ messageId: existing.id }, "reaction role admin UI reconnected via scan");
      return;
    }
  }

  try {
    const sent = await ch.send({ embeds: [embed], components });
    await savePanelMessageRow(ctx, row.id, channelId, sent.id, {
      ui_version: codeVer,
      status: "sent",
      last_sent_at: new Date().toISOString(),
    });
    ctx.log.info({ messageId: sent.id }, "reaction role admin UI sent");
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    await savePanelMessageRow(ctx, row.id, channelId, row.message_id, {
      ...row.data,
      status: "error",
      last_error: err.slice(0, 500),
    });
    ctx.log.error({ err: e }, "reaction role admin UI send failed");
  }
}

let entriesReconcileRunning = false;

export async function reconcileReactionRoleEntriesOnly(ctx: BotContext, guild: Guild): Promise<void> {
  if (entriesReconcileRunning) return;
  entriesReconcileRunning = true;
  try {
    const entries = await loadEntriesForGuild(ctx.db, guild.id);
    for (const e of entries) {
      if (e.roles.length === 0) continue;
      try {
        const messageId = await sendOrUpdateEntryMessage(ctx, guild, e);
        if (messageId !== e.messageId) {
          await setEntryMessageId(ctx.db, guild.id, e.entryId, messageId, e.channelId);
        }
      } catch (err) {
        ctx.log.warn({ err, entryId: e.entryId }, "reaction role entry reconnect failed");
      }
    }
  } finally {
    entriesReconcileRunning = false;
  }
}

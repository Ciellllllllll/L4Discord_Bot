import { ComponentCardBuilder, componentCardsPayload } from "../../core/componentCard.js";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Guild,
  type Message,
} from "discord.js";
import type { CoreDeps } from "../../core/deps.js";
import { buildContainerPanelPayload, messageComponentsHaveCustomId } from "../panels/componentPanelPayload.js";
import {
  ADMIN_CREATE_BUTTON_ID,
  ADMIN_DELETE_BUTTON_ID,
  ADMIN_EDIT_BUTTON_ID,
  TOGGLE_PREFIX,
} from "./reactionRoleConstants.js";
import type { ReactionRoleEntry } from "./reactionRoleModel.js";

// リアクションロールの Discord メッセージ組み立てと送信。

// ReactionRoleService が使う依存。
export type ReactionRoleServiceDeps = Pick<CoreDeps, "config" | "db" | "log" | "client">;

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

export function buildEntryEmbed(entry: ReactionRoleEntry): ComponentCardBuilder {
  return new ComponentCardBuilder()
    .setTitle(entry.title || "Reaction Role")
    .setDescription(entry.description || "ボタンを押してロールを付与/解除します。")
}

export function buildReactionRoleAdminPanelPayload(uiChannelMention: string) {
  return buildContainerPanelPayload(
    [
      "## リアクションロール管理",
      "ロール付与パネルの作成・編集・削除をこのパネルから行えます。",
      "",
      "**管理操作**   作成   編集   削除",
      "**ロール数**   1パネル最大5件",
      "",
      "**入力形式**",
      "`roleId|label|emoji` を1行ずつ入力します。",
      "例: `123456789012345678|お知らせ`",
      "",
      "**絵文字**",
      "Unicode、ID、name、`:name:`、`<:name:id>`、`<a:name:id>` に対応します。",
      "",
      `**設置先**   ${uiChannelMention}`,
      "",
    ].join("\n"),
    buildAdminRows(),
  );
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

export function messageHasCustomId(message: Message, customId: string): boolean {
  return messageComponentsHaveCustomId(message.components, new Set([customId]));
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
  ctx: ReactionRoleServiceDeps,
  guild: Guild,
  entry: ReactionRoleEntry,
): Promise<string> {
  const channel = await resolveTextChannel(guild, entry.channelId);
  if (!channel) {
    throw new Error(`channel not found: ${entry.channelId}`);
  }
  const payload = {
    ...componentCardsPayload([buildEntryEmbed(entry)], buildEntryRows(entry)),
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

export async function deleteEntryDiscordMessage(ctx: ReactionRoleServiceDeps, guild: Guild, entry: ReactionRoleEntry): Promise<void> {
  if (!entry.messageId) return;
  const channel = await resolveTextChannel(guild, entry.channelId);
  if (!channel) return;
  const msg = await channel.messages.fetch(entry.messageId).catch(() => null);
  if (msg && msg.author?.id === ctx.client.user?.id) {
    await msg.delete().catch(() => undefined);
  }
}

import { ComponentCardBuilder, componentCardsPayload, ephemeralComponentPayload } from "../panels/componentCard.js";
import {
  MessageFlags,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { BotContext } from "../../bot/context.js";
import {
  applyDispatchResult,
  cancelReminderForAuthor,
  createReminderHubEntry,
  getActiveForAuthor,
  getReminderRowForAuthor,
  listActiveByType,
  reminderRowStoredData,
  updateReminderHubChannel,
  updateReminderHubContent,
} from "./reminderHubRepo.js";
import {
  buildCreateChannelPayload,
  buildCreateModal,
  buildEditModal,
  buildManageDetailPayload,
  buildManageListPayload,
  type ReminderHubMessagePayload,
} from "./reminderHubPayload.js";
import { sendReminderHubMessage } from "./reminderHubSend.js";
import {
  EDIT_MODAL_PREFIX,
  EVENT_META,
  formatDue,
  normalizeEventType,
  parseDueAt,
  parseRecurrenceInput,
  type ReminderEvType,
} from "./reminderHubTypes.js";

function makeInfoEmbed(title: string, description: string, _color?: number): ComponentCardBuilder {
  return new ComponentCardBuilder().setTitle(title).setDescription(description);
}

// DiscordBotv2 と同一のボタン customId か（誤ルーティング防止）

function isReminderSystemButtonId(id: string): boolean {
  if (
    id === "reminder_create" ||
    id === "todo_create" ||
    id === "notice_create" ||
    id === "reminder_manage" ||
    id === "reminder_list"
  ) {
    return true;
  }
  return id.startsWith("rem_manage_") || id.startsWith("rem_create_channel_id:");
}

async function buildManageListForUser(
  ctx: BotContext,
  guildId: string,
  userId: string,
  kind: ReminderEvType,
  noticeText = "",
): Promise<ReminderHubMessagePayload> {
  const rows = await listActiveByType(ctx, guildId, userId, kind);
  return buildManageListPayload(kind, rows, noticeText);
}

export async function handleReminderHubButton(interaction: ButtonInteraction, ctx: BotContext): Promise<boolean> {
  if (!isReminderSystemButtonId(interaction.customId)) return false;

  const id = interaction.customId;
  const createMap: Record<string, ReminderEvType> = {
    reminder_create: "reminder",
    todo_create: "todo",
    notice_create: "notice",
  };

  if (id.startsWith("rem_create_channel_id:")) {
    if (!interaction.guild) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "サーバー内でのみ利用できます。", 0xe74c3c)]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    const kind = normalizeEventType(id.slice("rem_create_channel_id:".length));
    await interaction.showModal(buildCreateModal(kind));
    return true;
  }

  if (createMap[id]) {
    if (!interaction.guild) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "サーバー内でのみ利用できます。", 0xe74c3c)]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    await interaction.reply(ephemeralComponentPayload(buildCreateChannelPayload(createMap[id])));
    return true;
  }

  if (id === "reminder_manage" || id === "reminder_list") {
    if (!interaction.guild) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "サーバー内でのみ利用できます。", 0xe74c3c)]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    const payload = await buildManageListForUser(ctx, interaction.guild.id, interaction.user.id, "reminder");
    await interaction.reply(ephemeralComponentPayload(payload));
    return true;
  }

  if (id.startsWith("rem_manage_tab:") || id.startsWith("rem_manage_back:") || id.startsWith("rem_manage_refresh:")) {
    if (!interaction.guild) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "サーバー内でのみ利用できます。", 0xe74c3c)]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    const kind = normalizeEventType(id.split(":")[1] ?? "reminder");
    const payload = await buildManageListForUser(ctx, interaction.guild.id, interaction.user.id, kind);
    await interaction.update(payload);
    return true;
  }

  if (id.startsWith("rem_manage_edit:")) {
    if (!interaction.guild) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "サーバー内でのみ利用できます。", 0xe74c3c)]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    const rowId = id.slice("rem_manage_edit:".length);
    const row = await getActiveForAuthor(ctx, interaction.guild.id, interaction.user.id, rowId);
    if (!row) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "対象が見つからないか、すでに無効です。", 0xe74c3c)]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    await interaction.showModal(buildEditModal(row));
    return true;
  }

  if (id.startsWith("rem_manage_delete:")) {
    if (!interaction.guild) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "サーバー内でのみ利用できます。", 0xe74c3c)]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    const rowId = id.slice("rem_manage_delete:".length);
    const current = await getActiveForAuthor(ctx, interaction.guild.id, interaction.user.id, rowId);
    if (!current) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "対象が見つからないか、すでに無効です。", 0xe74c3c)]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    await cancelReminderForAuthor(ctx, interaction.guild.id, interaction.user.id, rowId);
    const payload = await buildManageListForUser(
      ctx,
      interaction.guild.id,
      interaction.user.id,
      current.ev_type,
      `#${rowId} を削除しました。`,
    );
    await interaction.update(payload);
    return true;
  }

  if (id.startsWith("rem_manage_post:")) {
    if (!interaction.guild) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "サーバー内でのみ利用できます。", 0xe74c3c)]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    const rowId = id.slice("rem_manage_post:".length);
    const full = await getReminderRowForAuthor(ctx, interaction.guild.id, interaction.user.id, rowId);
    if (!full) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "対象が見つからないか、すでに無効です。", 0xe74c3c)]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    await interaction.deferUpdate();
    await sendReminderHubMessage(ctx, full);
    await applyDispatchResult(ctx, full, true);
    const refreshed = await getActiveForAuthor(ctx, interaction.guild.id, interaction.user.id, rowId);
    if (refreshed) {
      const payload = buildManageDetailPayload(refreshed, `#${rowId} を即時投稿しました。`);
      await interaction.editReply(payload);
    } else {
      const kindFromRow = reminderRowStoredData(full).ev_type;
      const payload = await buildManageListForUser(
        ctx,
        interaction.guild.id,
        interaction.user.id,
        kindFromRow,
        `#${rowId} を即時投稿しました。`,
      );
      await interaction.editReply(payload);
    }
    return true;
  }

  return false;
}

export async function handleReminderHubStringSelect(
  interaction: StringSelectMenuInteraction,
  ctx: BotContext,
): Promise<boolean> {
  if (!interaction.customId.startsWith("rem_manage_pick:")) return false;
  if (!interaction.guild) {
    await interaction.reply({
      ...componentCardsPayload([makeInfoEmbed("エラー", "サーバー内でのみ利用できます。", 0xe74c3c)]),
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
    return true;
  }
  const kind = normalizeEventType(interaction.customId.split(":")[1] ?? "reminder");
  const rowId = interaction.values[0];
  if (!rowId) {
    const payload = await buildManageListForUser(
      ctx,
      interaction.guild.id,
      interaction.user.id,
      kind,
      "対象IDが不正です。",
    );
    await interaction.update(payload);
    return true;
  }
  const row = await getActiveForAuthor(ctx, interaction.guild.id, interaction.user.id, rowId);
  if (!row) {
    const payload = await buildManageListForUser(
      ctx,
      interaction.guild.id,
      interaction.user.id,
      kind,
      "対象が見つからないか、すでに無効です。",
    );
    await interaction.update(payload);
    return true;
  }
  await interaction.update(buildManageDetailPayload(row));
  return true;
}

export async function handleReminderHubChannelSelect(
  interaction: ChannelSelectMenuInteraction,
  ctx: BotContext,
): Promise<boolean> {
  const cid = interaction.customId;
  if (!cid.startsWith("rem_create_channel:") && !cid.startsWith("rem_manage_channel_pick:")) {
    return false;
  }

  if (cid.startsWith("rem_create_channel:")) {
    if (!interaction.guild) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "サーバー内でのみ利用できます。", 0xe74c3c)]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    const kind = normalizeEventType(cid.slice("rem_create_channel:".length));
    const channelId = interaction.values[0];
    if (!channelId || !/^\d+$/.test(channelId)) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "チャンネルIDが不正です。", 0xe74c3c)]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    await interaction.showModal(buildCreateModal(kind, channelId));
    return true;
  }

  if (cid.startsWith("rem_manage_channel_pick:")) {
    if (!interaction.guild) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "サーバー内でのみ利用できます。", 0xe74c3c)]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    const rowId = cid.slice("rem_manage_channel_pick:".length);
    const channelId = interaction.values[0];
    if (!channelId || !/^\d+$/.test(channelId)) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "入力が不正です。", 0xe74c3c)]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    const current = await getActiveForAuthor(ctx, interaction.guild.id, interaction.user.id, rowId);
    if (!current) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "対象が見つからないか、すでに無効です。", 0xe74c3c)]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    await updateReminderHubChannel(ctx, interaction.guild.id, interaction.user.id, rowId, channelId);
    const refreshed = await getActiveForAuthor(ctx, interaction.guild.id, interaction.user.id, rowId);
    if (!refreshed) {
      const payload = await buildManageListForUser(
        ctx,
        interaction.guild.id,
        interaction.user.id,
        current.ev_type,
        "更新後データが取得できませんでした。",
      );
      await interaction.update(payload);
      return true;
    }
    await interaction.update(
      buildManageDetailPayload(refreshed, `投稿先を <#${channelId}> に変更しました。`),
    );
    return true;
  }

  return false;
}

export async function handleReminderHubModal(interaction: ModalSubmitInteraction, ctx: BotContext): Promise<boolean> {
  if (interaction.customId.startsWith("reminder_modal:")) {
    if (!interaction.guild) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "サーバー内でのみ利用できます。", 0xe74c3c)]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    const parts = interaction.customId.split(":");
    if (parts[0] !== "reminder_modal" || parts.length !== 2) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "モーダルIDが不正です。", 0xe74c3c)]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    const kindRaw = parts[1] ?? "reminder";
    const kind = normalizeEventType(kindRaw);
    const channelId = interaction.fields.getTextInputValue("channel_id").trim();
    if (!channelId || !/^\d+$/.test(channelId)) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "チャンネルが不正です。", 0xe74c3c)]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }

    const title = interaction.fields.getTextInputValue("title").trim();
    const body = interaction.fields.getTextInputValue("body").trim();
    const dueRaw = interaction.fields.getTextInputValue("due_at").trim();
    const recRaw = interaction.fields.getTextInputValue("recurrence").trim();

    const dueAt = parseDueAt(dueRaw);
    if (!dueAt) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("入力エラー", "期限の形式が不正です。", 0xe74c3c)]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    const recParse = parseRecurrenceInput(recRaw);
    if (!recParse.valid) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("入力エラー", "繰り返しは `10m` `1h` `1d` 形式で入力してください。", 0xe74c3c)]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }

    const newId = await createReminderHubEntry(ctx, {
      guildId: interaction.guild.id,
      authorId: interaction.user.id,
      evType: kind,
      title,
      body,
      channelId,
      fireAt: dueAt,
      recurrence: recParse.value,
    });

    const embed = new ComponentCardBuilder()
      .setTitle(`${EVENT_META[kind].label}を作成しました`)
      .setDescription(`ID: **${newId}**`)
      .addFields(
        { name: "投稿先", value: `<#${channelId}>`, inline: true },
        { name: "期限", value: formatDue(dueAt.toISOString()), inline: true },
        { name: "繰り返し", value: recParse.value ? recRaw : "なし", inline: true },
      );
    await interaction.reply({ ...componentCardsPayload([embed]), flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
    return true;
  }

  if (interaction.customId.startsWith(`${EDIT_MODAL_PREFIX}:`)) {
    if (!interaction.guild) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "サーバー内でのみ利用できます。", 0xe74c3c)]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    const rowId = interaction.customId.slice(`${EDIT_MODAL_PREFIX}:`.length);
    const current = await getActiveForAuthor(ctx, interaction.guild.id, interaction.user.id, rowId);
    if (!current) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "対象が見つからないか、すでに無効です。", 0xe74c3c)]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }

    const title = interaction.fields.getTextInputValue("title").trim();
    const body = interaction.fields.getTextInputValue("body").trim();
    const dueRaw = interaction.fields.getTextInputValue("due_at").trim();
    const recRaw = interaction.fields.getTextInputValue("recurrence").trim();
    const channelId = interaction.fields.getTextInputValue("channel_id").trim();

    if (!/^\d+$/.test(channelId)) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("入力エラー", "チャンネルIDは数字のみで入力してください。", 0xe74c3c)]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }

    const dueAt = parseDueAt(dueRaw);
    if (!dueAt) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("入力エラー", "期限の形式が不正です。", 0xe74c3c)]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    const recParse = parseRecurrenceInput(recRaw);
    if (!recParse.valid) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("入力エラー", "繰り返しは `10m` `1h` `1d` 形式で入力してください。", 0xe74c3c)]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }

    await updateReminderHubContent(ctx, {
      guildId: interaction.guild.id,
      authorId: interaction.user.id,
      id: rowId,
      title,
      body,
      fireAt: dueAt,
      recurrence: recParse.value,
    });
    await updateReminderHubChannel(ctx, interaction.guild.id, interaction.user.id, rowId, channelId);

    const refreshed = await getActiveForAuthor(ctx, interaction.guild.id, interaction.user.id, rowId);
    if (!refreshed) {
      const payload = await buildManageListForUser(
        ctx,
        interaction.guild.id,
        interaction.user.id,
        current.ev_type,
        "更新しましたが一覧の再取得に失敗しました。",
      );
      await interaction.reply(ephemeralComponentPayload(payload));
      return true;
    }
    await interaction.reply({
      ...ephemeralComponentPayload(buildManageDetailPayload(refreshed, `#${rowId} を更新しました。`)),
    });
    return true;
  }

  return false;
}

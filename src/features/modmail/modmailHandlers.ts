import {
  ActionRowBuilder,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import type { BotContext } from "../../bot/context.js";
import {
  deletePendingModmailContext,
  getPendingModmailContext,
  MODMAIL_BODY_FIELD,
  MODMAIL_TICKET_START_PREFIX,
  MODMAIL_TICKET_SUBMIT_PREFIX,
  MODMAIL_TITLE_FIELD,
} from "./modmailConstants.js";
import { buildModmailStartAttachmentRow, buildModmailTicketStartRows } from "./modmailUi.js";
import {
  createTicketFromIntakeForm,
  openModmailByGuildUser,
  sendModmailStartDm,
  upsertModmailIntake,
} from "./modmailService.js";

function safeText(value: string, fallback = "-"): string {
  const t = value?.trim() ?? "";
  return t || fallback;
}

async function deferReplyGuildEphemeral(interaction: ButtonInteraction | ModalSubmitInteraction): Promise<boolean> {
  if (interaction.deferred || interaction.replied) return true;
  try {
    if (interaction.guildId) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } else {
      await interaction.deferReply();
    }
    return true;
  } catch {
    return false;
  }
}

async function respondEphemeralOrDm(
  interaction: ModalSubmitInteraction,
  payload: { content: string },
): Promise<void> {
  const ephemeral = Boolean(interaction.guildId);
  const flags = ephemeral ? MessageFlags.Ephemeral : undefined;
  try {
    if (interaction.deferred) {
      await interaction.editReply({ content: payload.content });
      return;
    }
    if (interaction.replied) {
      await interaction.followUp({ ...payload, ...(flags !== undefined ? { flags } : {}) });
      return;
    }
    await interaction.reply({ ...payload, ...(flags !== undefined ? { flags } : {}) });
  } catch {
    /* ignore */
  }
}

export async function handleUserPanelModmailStart(
  interaction: ButtonInteraction,
  ctx: BotContext,
): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "ギルド内でのみ利用できます。", ephemeral: true });
    return;
  }
  const guildId = interaction.guildId;
  const uid = interaction.user.id;

  const open = await openModmailByGuildUser(ctx, guildId, uid);
  if (open) {
    await interaction.reply({ content: "現在対応中のチケットがあります。新規作成はできません。", ephemeral: true });
    return;
  }

  try {
    await upsertModmailIntake(ctx, guildId, uid);
    const { rows } = buildModmailTicketStartRows(guildId, uid);
    await sendModmailStartDm(interaction.user, [...rows, buildModmailStartAttachmentRow(guildId, uid)]);
    await interaction.reply({
      content: "DM を送信しました。DM の「チケットを作成」ボタンから受付してください。",
      flags: MessageFlags.Ephemeral,
    });
  } catch (e) {
    ctx.log.warn({ err: e, guildId, userId: uid }, "modmail start DM failed");
    await interaction.reply({
      content: "Bot から DM を送信できませんでした。Bot の DM を受け取れる設定にしてください。",
      flags: MessageFlags.Ephemeral,
    });
  }
}

export async function handleUserPanelTicketGuild(
  interaction: ButtonInteraction,
  ctx: BotContext,
): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "ギルド内でのみ利用できます。", ephemeral: true });
    return;
  }
  const guildId = interaction.guildId;
  const uid = interaction.user.id;

  const open = await openModmailByGuildUser(ctx, guildId, uid);
  if (open) {
    await interaction.reply({ content: "現在対応中のチケットがあります。新規作成はできません。", ephemeral: true });
    return;
  }

  await upsertModmailIntake(ctx, guildId, uid);
  const { rows } = buildModmailTicketStartRows(guildId, uid);
  const guide = new EmbedBuilder()
    .setTitle("チケット作成")
    .setDescription(
      "下の「チケットを作成」ボタンからタイトルと詳細を入力してください（DM が不要な場合はこちら）。",
    )
    .setColor(0x57f287);
  await interaction.reply({
    embeds: [guide],
    components: rows,
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleModmailTicketStartButton(
  interaction: ButtonInteraction,
  ctx: BotContext,
): Promise<boolean> {
  if (!interaction.customId.startsWith(MODMAIL_TICKET_START_PREFIX)) return false;

  const ctxId = interaction.customId.slice(MODMAIL_TICKET_START_PREFIX.length);
  const pending = getPendingModmailContext(ctxId);
  if (!pending) {
    await interaction.reply({
      content: "このチケット作成ボタンは期限切れです。",
      ...(interaction.guildId ? { flags: MessageFlags.Ephemeral } : {}),
    });
    return true;
  }
  if (interaction.user.id !== pending.userId) {
    await interaction.reply({
      content: "このボタンは対象ユーザーのみ利用できます。",
      ...(interaction.guildId ? { flags: MessageFlags.Ephemeral } : {}),
    });
    return true;
  }
  if (pending.buttonFired) {
    await interaction.message?.edit({ components: [] }).catch(() => undefined);
    await interaction.reply({
      content: "このチケット作成ボタンはすでに使用済みです。",
      ...(interaction.guildId ? { flags: MessageFlags.Ephemeral } : {}),
    });
    return true;
  }

  pending.buttonFired = true;
  const modal = new ModalBuilder()
    .setCustomId(`${MODMAIL_TICKET_SUBMIT_PREFIX}${ctxId}`)
    .setTitle("チケットを作成")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(MODMAIL_TITLE_FIELD)
          .setLabel("タイトル")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(120),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(MODMAIL_BODY_FIELD)
          .setLabel("詳細")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(2000)
          .setPlaceholder("添付が必要な場合は、送信後の案内に従って DM で送ってください。"),
      ),
    );

  try {
    await interaction.showModal(modal);
    await interaction.message?.edit({ components: [] }).catch(() => undefined);
  } catch (e) {
    pending.buttonFired = false;
    ctx.log.warn({ err: e }, "modmail show modal failed");
    await interaction.reply({
      content: "モーダルの表示に失敗しました。時間をおいて再試行してください。",
      ...(interaction.guildId ? { flags: MessageFlags.Ephemeral } : {}),
    });
  }
  return true;
}

export async function handleModmailTicketSubmitModal(
  interaction: ModalSubmitInteraction,
  ctx: BotContext,
): Promise<boolean> {
  if (!interaction.customId.startsWith(MODMAIL_TICKET_SUBMIT_PREFIX)) return false;

  const ctxId = interaction.customId.slice(MODMAIL_TICKET_SUBMIT_PREFIX.length);
  const pending = getPendingModmailContext(ctxId);
  if (!pending) {
    await respondEphemeralOrDm(interaction, { content: "チケット作成情報が期限切れです。" });
    return true;
  }
  if (interaction.user.id !== pending.userId) {
    await respondEphemeralOrDm(interaction, { content: "このフォームは対象ユーザーのみ送信できます。" });
    return true;
  }

  const title = safeText(interaction.fields.getTextInputValue(MODMAIL_TITLE_FIELD), "");
  const body = safeText(interaction.fields.getTextInputValue(MODMAIL_BODY_FIELD), "");

  const deferred = await deferReplyGuildEphemeral(interaction);
  if (!deferred && !interaction.deferred && !interaction.replied) return true;

  try {
    const result = await createTicketFromIntakeForm(ctx, {
      guildId: pending.guildId,
      user: interaction.user,
      title,
      body,
    });
    if (!result.ok) {
      await respondEphemeralOrDm(interaction, { content: result.message });
      return true;
    }
    deletePendingModmailContext(ctxId);
    await respondEphemeralOrDm(interaction, { content: result.message });
  } catch (e) {
    ctx.log.warn({ err: e }, "modmail modal submit failed");
    await respondEphemeralOrDm(interaction, {
      content: "チケット作成に失敗しました。時間をおいて再試行してください。",
    });
  }
  return true;
}

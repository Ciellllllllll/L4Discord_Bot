import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type InteractionReplyOptions,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { getGuildSettingsData } from "../../core/guildSettings.js";
import { getReactionRoleUiChannelId } from "./reactionRoleService.js";
import {
  ADMIN_CREATE_BUTTON_ID,
  ADMIN_CREATE_MODAL_ID,
  ADMIN_DELETE_SELECT_ID,
  ADMIN_EDIT_BUTTON_ID,
  ADMIN_EDIT_MODAL_PREFIX,
  ADMIN_EDIT_SELECT_ID,
  ADMIN_DELETE_BUTTON_ID,
  RR_MODAL_CHANNEL,
  RR_MODAL_DESCRIPTION,
  RR_MODAL_ROLES,
  RR_MODAL_TITLE,
  TOGGLE_PREFIX,
} from "./reactionRoleConstants.js";
import {
  deleteEntryDiscordMessage,
  deleteEntryRow,
  extractChannelId,
  formatRolesForInput,
  getEntryByEntryId,
  insertEntry,
  loadEntriesForGuild,
  makeEntryId,
  parseRoleLines,
  sendOrUpdateEntryMessage,
  truncateText,
  updateEntryRow,
  type ReactionRoleEntry,
} from "./reactionRoleService.js";

function canManageRoles(
  interaction: ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction,
): boolean {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles) ?? false;
}

async function replyEphemeral(
  interaction: ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction,
  content: string,
  components?: ActionRowBuilder<StringSelectMenuBuilder>[],
): Promise<void> {
  const payload: InteractionReplyOptions = { content, flags: MessageFlags.Ephemeral, components };
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(payload).catch(() => undefined);
    return;
  }
  await interaction.reply(payload).catch(() => undefined);
}

function buildEntrySelectRows(
  entries: ReactionRoleEntry[],
  customId: string,
  placeholder: string,
): ActionRowBuilder<StringSelectMenuBuilder>[] {
  const options = entries.slice(0, 25).map((entry) => ({
    label: truncateText(`${entry.title || "Reaction Role"} (${entry.entryId})`, 100),
    description: truncateText(`ch:${entry.channelId} roles:${entry.roles.length}`, 100),
    value: entry.entryId,
  }));
  const menu = new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).addOptions(options);
  return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)];
}

function parseEntryIdFromEditModal(customId: string): string | null {
  if (!customId.startsWith(ADMIN_EDIT_MODAL_PREFIX)) return null;
  const entryId = customId.slice(ADMIN_EDIT_MODAL_PREFIX.length).trim();
  return entryId || null;
}

function showCreateModal(interaction: ButtonInteraction, defaultChannelId?: string): Promise<void> {
  const modal = new ModalBuilder().setCustomId(ADMIN_CREATE_MODAL_ID).setTitle("Reaction Role 作成");

  const channelInput = new TextInputBuilder()
    .setCustomId(RR_MODAL_CHANNEL)
    .setLabel("送信先チャンネルID または #mention")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder("123456789012345678");
  if (defaultChannelId) channelInput.setValue(defaultChannelId);

  const titleInput = new TextInputBuilder()
    .setCustomId(RR_MODAL_TITLE)
    .setLabel("タイトル")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(256)
    .setPlaceholder("Reaction Role");

  const descriptionInput = new TextInputBuilder()
    .setCustomId(RR_MODAL_DESCRIPTION)
    .setLabel("説明 (任意)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(1000)
    .setPlaceholder("ボタンを押してロールを付与/解除します。");

  const rolesInput = new TextInputBuilder()
    .setCustomId(RR_MODAL_ROLES)
    .setLabel("roles: roleId|label|emoji (最大5行)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1000)
    .setPlaceholder("123456789012345678|お知らせ|📢");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(channelInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(titleInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(descriptionInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(rolesInput),
  );
  return interaction.showModal(modal);
}

function showEditModal(interaction: StringSelectMenuInteraction, entry: ReactionRoleEntry): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId(`${ADMIN_EDIT_MODAL_PREFIX}${entry.entryId}`)
    .setTitle("Reaction Role 編集");

  const channelInput = new TextInputBuilder()
    .setCustomId(RR_MODAL_CHANNEL)
    .setLabel("送信先チャンネルID または #mention (空欄で据え置き)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(64)
    .setPlaceholder(entry.channelId || "123456789012345678");
  if (entry.channelId) channelInput.setValue(entry.channelId);

  const titleInput = new TextInputBuilder()
    .setCustomId(RR_MODAL_TITLE)
    .setLabel("タイトル (空欄で据え置き)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(256)
    .setPlaceholder(entry.title || "Reaction Role");
  if (entry.title) titleInput.setValue(entry.title.slice(0, 256));

  const descriptionInput = new TextInputBuilder()
    .setCustomId(RR_MODAL_DESCRIPTION)
    .setLabel("説明 (空欄でクリア)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(1000)
    .setPlaceholder("ボタンを押してロールを付与/解除します。");
  if (entry.description) descriptionInput.setValue(entry.description.slice(0, 1000));

  const rolesInput = new TextInputBuilder()
    .setCustomId(RR_MODAL_ROLES)
    .setLabel("roles: roleId|label|emoji (空欄で据え置き)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(1000)
    .setPlaceholder(formatRolesForInput(entry.roles));
  const roleLines = formatRolesForInput(entry.roles).slice(0, 1000);
  if (roleLines) rolesInput.setValue(roleLines);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(channelInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(titleInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(descriptionInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(rolesInput),
  );
  return interaction.showModal(modal);
}

async function handleRoleToggle(interaction: ButtonInteraction, ctx: BotContext): Promise<void> {
  if (!interaction.guild) {
    await replyEphemeral(interaction, "Guild only");
    return;
  }
  const parts = String(interaction.customId || "").split(":");
  if (parts.length < 3) {
    await replyEphemeral(interaction, "不正なボタンです。");
    return;
  }
  const roleId = parts[parts.length - 1]!;
  const role =
    interaction.guild.roles.cache.get(roleId) ?? (await interaction.guild.roles.fetch(roleId).catch(() => null));
  if (!role) {
    await replyEphemeral(interaction, "対象ロールが見つかりません。");
    return;
  }
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) {
    await replyEphemeral(interaction, "メンバー情報の取得に失敗しました。");
    return;
  }
  const me = interaction.guild.members.me ?? (await interaction.guild.members.fetchMe().catch(() => null));
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    await replyEphemeral(interaction, "Bot にロール管理権限がありません。");
    return;
  }
  if (role.managed) {
    await replyEphemeral(interaction, "このロールは管理対象外のため変更できません。");
    return;
  }
  if (role.position >= me.roles.highest.position) {
    await replyEphemeral(interaction, "Bot のロール階層が不足しているため変更できません。");
    return;
  }
  const hasRole = member.roles.cache.has(role.id);
  try {
    if (hasRole) {
      await member.roles.remove(role, "reaction role toggle");
      await replyEphemeral(interaction, `${role} を解除しました。`);
    } else {
      await member.roles.add(role, "reaction role toggle");
      await replyEphemeral(interaction, `${role} を付与しました。`);
    }
  } catch (err) {
    ctx.log.warn(
      { err, guildId: interaction.guild.id, userId: interaction.user.id, roleId: role.id },
      "reaction role toggle failed",
    );
    await replyEphemeral(interaction, "ロールの更新に失敗しました。権限とロール階層を確認してください。");
  }
}

export async function handleReactionRoleButton(interaction: ButtonInteraction, ctx: BotContext): Promise<boolean> {
  const id = interaction.customId;
  if (id.startsWith(TOGGLE_PREFIX)) {
    await handleRoleToggle(interaction, ctx);
    return true;
  }
  if (id === ADMIN_CREATE_BUTTON_ID || id === ADMIN_EDIT_BUTTON_ID || id === ADMIN_DELETE_BUTTON_ID) {
    if (!interaction.guild || !canManageRoles(interaction)) {
      await replyEphemeral(interaction, "ロールの管理権限がありません。");
      return true;
    }
    if (id === ADMIN_CREATE_BUTTON_ID) {
      const s = await getGuildSettingsData(ctx.db, interaction.guild.id);
      const adminCh = s.panel_channels?.admin_channel_id?.trim();
      const def =
        adminCh && /^\d+$/.test(adminCh) ? adminCh : getReactionRoleUiChannelId(ctx.config);
      await showCreateModal(interaction, def);
      return true;
    }
    if (id === ADMIN_EDIT_BUTTON_ID) {
      const entries = await loadEntriesForGuild(ctx.db, interaction.guild.id);
      if (!entries.length) {
        await replyEphemeral(interaction, "編集対象の entry がありません。");
        return true;
      }
      const rows = buildEntrySelectRows(entries, ADMIN_EDIT_SELECT_ID, "編集する entry を選択");
      await replyEphemeral(interaction, "編集対象を選択してください。", rows);
      return true;
    }
    if (id === ADMIN_DELETE_BUTTON_ID) {
      const entries = await loadEntriesForGuild(ctx.db, interaction.guild.id);
      if (!entries.length) {
        await replyEphemeral(interaction, "削除対象の entry がありません。");
        return true;
      }
      const rows = buildEntrySelectRows(entries, ADMIN_DELETE_SELECT_ID, "削除する entry を選択");
      await replyEphemeral(interaction, "削除対象を選択してください。", rows);
      return true;
    }
  }
  return false;
}

export async function handleReactionRoleStringSelect(
  interaction: StringSelectMenuInteraction,
  ctx: BotContext,
): Promise<boolean> {
  if (interaction.customId !== ADMIN_EDIT_SELECT_ID && interaction.customId !== ADMIN_DELETE_SELECT_ID) {
    return false;
  }
  if (!interaction.guild || !canManageRoles(interaction)) {
    await replyEphemeral(interaction, "ロールの管理権限がありません。");
    return true;
  }
  const entryId = interaction.values[0];
  if (!entryId) {
    await replyEphemeral(interaction, "entry_id の取得に失敗しました。");
    return true;
  }
  if (interaction.customId === ADMIN_DELETE_SELECT_ID) {
    const entry = await getEntryByEntryId(ctx.db, interaction.guild.id, entryId);
    if (!entry) {
      await replyEphemeral(interaction, "entry_id が見つかりません。");
      return true;
    }
    await deleteEntryDiscordMessage(ctx, interaction.guild, entry);
    await deleteEntryRow(ctx.db, interaction.guild.id, entryId);
    await replyEphemeral(interaction, `削除しました。entry_id=${entryId}`);
    return true;
  }
  const entry = await getEntryByEntryId(ctx.db, interaction.guild.id, entryId);
  if (!entry) {
    await replyEphemeral(interaction, "entry_id が見つかりません。");
    return true;
  }
  await showEditModal(interaction, entry);
  return true;
}

export async function handleReactionRoleModal(interaction: ModalSubmitInteraction, ctx: BotContext): Promise<boolean> {
  if (interaction.customId === ADMIN_CREATE_MODAL_ID) {
    if (!interaction.guild || !canManageRoles(interaction)) {
      await replyEphemeral(interaction, "ロールの管理権限がありません。");
      return true;
    }
    const channelRaw = interaction.fields.getTextInputValue(RR_MODAL_CHANNEL);
    const titleRaw = interaction.fields.getTextInputValue(RR_MODAL_TITLE);
    const descriptionRaw = interaction.fields.getTextInputValue(RR_MODAL_DESCRIPTION);
    const rolesRaw = interaction.fields.getTextInputValue(RR_MODAL_ROLES);
    const channelId = extractChannelId(channelRaw);
    if (!channelId) {
      await replyEphemeral(interaction, "送信先チャンネルIDの形式が不正です。");
      return true;
    }
    const title = String(titleRaw || "").trim().slice(0, 256);
    if (!title) {
      await replyEphemeral(interaction, "タイトルを入力してください。");
      return true;
    }
    const roles = parseRoleLines(rolesRaw);
    if (!roles.length) {
      await replyEphemeral(
        interaction,
        "roles の形式が不正です。 roleId|label|emoji を行単位で指定してください。",
      );
      return true;
    }
    const entry: ReactionRoleEntry = {
      entryId: makeEntryId(),
      channelId,
      messageId: null,
      title,
      description: String(descriptionRaw || "").slice(0, 1000),
      roles,
    };
    try {
      const messageId = await sendOrUpdateEntryMessage(ctx, interaction.guild, entry);
      entry.messageId = messageId;
      await insertEntry(ctx.db, interaction.guild.id, entry);
      await replyEphemeral(interaction, `リアクションロールを作成しました。entry_id=${entry.entryId}`);
    } catch (err) {
      ctx.log.warn(
        { err, guildId: interaction.guild.id, userId: interaction.user.id },
        "reaction role create failed",
      );
      await replyEphemeral(interaction, "作成に失敗しました。対象チャンネル、Bot の権限、ロール階層を確認してください。");
    }
    return true;
  }

  if (interaction.customId.startsWith(ADMIN_EDIT_MODAL_PREFIX)) {
    if (!interaction.guild || !canManageRoles(interaction)) {
      await replyEphemeral(interaction, "ロールの管理権限がありません。");
      return true;
    }
    const entryId = parseEntryIdFromEditModal(interaction.customId);
    if (!entryId) {
      await replyEphemeral(interaction, "entry_id が不正です。");
      return true;
    }
    const entry = await getEntryByEntryId(ctx.db, interaction.guild.id, entryId);
    if (!entry) {
      await replyEphemeral(interaction, "entry_id が見つかりません。");
      return true;
    }
    const channelRaw = String(interaction.fields.getTextInputValue(RR_MODAL_CHANNEL) || "").trim();
    const titleRaw = String(interaction.fields.getTextInputValue(RR_MODAL_TITLE) || "").trim();
    const descriptionRaw = String(interaction.fields.getTextInputValue(RR_MODAL_DESCRIPTION) || "");
    const rolesRaw = String(interaction.fields.getTextInputValue(RR_MODAL_ROLES) || "").trim();

    if (channelRaw) {
      const channelId = extractChannelId(channelRaw);
      if (!channelId) {
        await replyEphemeral(interaction, "送信先チャンネルIDの形式が不正です。");
        return true;
      }
      entry.channelId = channelId;
    }
    if (titleRaw) entry.title = titleRaw.slice(0, 256);
    entry.description = descriptionRaw.slice(0, 1000);
    if (rolesRaw) {
      const roles = parseRoleLines(rolesRaw);
      if (!roles.length) {
        await replyEphemeral(
          interaction,
          "roles の形式が不正です。 roleId|label|emoji を行単位で指定してください。",
        );
        return true;
      }
      entry.roles = roles;
    }
    try {
      const messageId = await sendOrUpdateEntryMessage(ctx, interaction.guild, entry);
      entry.messageId = messageId;
      await updateEntryRow(ctx.db, interaction.guild.id, entry);
      await replyEphemeral(interaction, "更新しました。");
    } catch (err) {
      ctx.log.warn(
        { err, guildId: interaction.guild.id, userId: interaction.user.id, entryId },
        "reaction role update failed",
      );
      await replyEphemeral(interaction, "更新に失敗しました。対象チャンネル、Bot の権限、ロール階層を確認してください。");
    }
    return true;
  }

  return false;
}

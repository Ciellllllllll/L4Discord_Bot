import {
  ActionRowBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { CoreDeps } from "../../core/deps.js";
import {
  ADMIN_CREATE_MODAL_ID,
  ADMIN_DELETE_SELECT_ID,
  ADMIN_EDIT_MODAL_PREFIX,
  ADMIN_EDIT_SELECT_ID,
  RR_MODAL_CHANNEL,
  RR_MODAL_DESCRIPTION,
  RR_MODAL_ROLES,
  RR_MODAL_TITLE,
} from "./reactionRoleConstants.js";
import {
  deleteEntryDiscordMessage,
  deleteEntryRow,
  extractChannelId,
  formatRolesForInput,
  getEntryByEntryId,
  insertEntry,
  makeEntryId,
  normalizeRoleLineEmojis,
  parseRoleLines,
  sendOrUpdateEntryMessage,
  truncateText,
  updateEntryRow,
  type ReactionRoleEntry,
} from "./reactionRoleService.js";
import { replyEphemeral } from "./reactionRoleInteractionReply.js";
import { canManageRoles, findDangerousRolesNotice, validateAssignableReactionRoles } from "./reactionRoleValidation.js";

// リアクションロールの管理 UI (セレクト・モーダル)。

export function buildEntrySelectRows(
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

function textInputPlaceholder(value: string, fallback: string): string {
  const text = String(value || "").trim() || fallback;
  return text.length <= 100 ? text : `${text.slice(0, 99)}…`;
}

export function showCreateModal(interaction: ButtonInteraction, defaultChannelId?: string): Promise<void> {
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
    .setPlaceholder("123456789012345678|お知らせ|📢\n123456789012345678|限定|:custom_name:");

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
    .setPlaceholder(textInputPlaceholder(formatRolesForInput(entry.roles), "roleId|label|emoji"));
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

export async function handleReactionRoleStringSelect(
  interaction: StringSelectMenuInteraction,
  ctx: Pick<CoreDeps, "config" | "db" | "log" | "client">,
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
  try {
    await showEditModal(interaction, entry);
  } catch (err) {
    ctx.log.warn(
      { err, guildId: interaction.guild.id, userId: interaction.user.id, entryId },
      "reaction role edit modal failed",
    );
    await replyEphemeral(interaction, "編集画面を開けませんでした。登録内容を確認してください。");
  }
  return true;
}

export async function handleReactionRoleModal(interaction: ModalSubmitInteraction, ctx: Pick<CoreDeps, "config" | "db" | "log" | "client">): Promise<boolean> {
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
    const normalized = await normalizeRoleLineEmojis(interaction.guild, roles);
    if (normalized.error) {
      await replyEphemeral(interaction, normalized.error);
      return true;
    }
    const actor =
      interaction.guild.members.cache.get(interaction.user.id) ??
      (await interaction.guild.members.fetch(interaction.user.id).catch(() => null));
    if (!actor) {
      await replyEphemeral(interaction, "メンバー情報の取得に失敗しました。");
      return true;
    }
    const roleValidationError = await validateAssignableReactionRoles(
      interaction.guild,
      actor,
      normalized.roles.map((item) => item.roleId),
    );
    if (roleValidationError) {
      await replyEphemeral(interaction, roleValidationError);
      return true;
    }
    const entry: ReactionRoleEntry = {
      entryId: makeEntryId(),
      channelId,
      messageId: null,
      title,
      description: String(descriptionRaw || "").slice(0, 1000),
      roles: normalized.roles,
    };
    try {
      const messageId = await sendOrUpdateEntryMessage(ctx, interaction.guild, entry);
      entry.messageId = messageId;
      await insertEntry(ctx.db, interaction.guild.id, entry);
      await replyEphemeral(
        interaction,
        `リアクションロールを作成しました。entry_id=${entry.entryId}`,
      );
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
    const existingRoleIds = new Set(entry.roles.map((item) => item.roleId));
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
      const normalized = await normalizeRoleLineEmojis(interaction.guild, roles);
      if (normalized.error) {
        await replyEphemeral(interaction, normalized.error);
        return true;
      }
      entry.roles = normalized.roles;
    }
    const addedRoleIds = entry.roles
      .map((item) => item.roleId)
      .filter((roleId) => !existingRoleIds.has(roleId));
    if (addedRoleIds.length > 0) {
      const actor =
        interaction.guild.members.cache.get(interaction.user.id) ??
        (await interaction.guild.members.fetch(interaction.user.id).catch(() => null));
      if (!actor) {
        await replyEphemeral(interaction, "メンバー情報の取得に失敗しました。");
        return true;
      }
      const roleValidationError = await validateAssignableReactionRoles(
        interaction.guild,
        actor,
        addedRoleIds,
      );
      if (roleValidationError) {
        await replyEphemeral(interaction, roleValidationError);
        return true;
      }
    }
    try {
      const messageId = await sendOrUpdateEntryMessage(ctx, interaction.guild, entry);
      entry.messageId = messageId;
      await updateEntryRow(ctx.db, interaction.guild.id, entry);
      const dangerousNotice = await findDangerousRolesNotice(
        interaction.guild,
        entry.roles.map((item) => item.roleId),
      );
      await replyEphemeral(interaction, `更新しました。${dangerousNotice ?? ""}`);
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

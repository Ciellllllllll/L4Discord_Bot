import { PermissionFlagsBits, type ButtonInteraction } from "discord.js";
import type { CoreDeps } from "../../core/deps.js";
import { getGuildSettingsData } from "../../core/guildSettings.js";
import { getReactionRoleUiChannelId } from "./reactionRoleService.js";
import {
  ADMIN_CREATE_BUTTON_ID,
  ADMIN_DELETE_BUTTON_ID,
  ADMIN_DELETE_SELECT_ID,
  ADMIN_EDIT_BUTTON_ID,
  ADMIN_EDIT_SELECT_ID,
  TOGGLE_PREFIX,
} from "./reactionRoleConstants.js";
import {
  getEntryByEntryId,
  loadEntriesForGuild,
} from "./reactionRoleService.js";
import { replyEphemeral } from "./reactionRoleInteractionReply.js";
import {
  canManageRoles,
  getDangerousReactionRolePermissionNames,
  parseToggleCustomId,
} from "./reactionRoleValidation.js";
import {
  buildEntrySelectRows,
  handleReactionRoleModal,
  handleReactionRoleStringSelect,
  showCreateModal,
} from "./reactionRoleAdminUi.js";
export {
  getDangerousReactionRolePermissionNames,
  hasDangerousReactionRolePermission,
  parseToggleCustomId,
  validateAssignableReactionRoles,
} from "./reactionRoleValidation.js";
export { handleReactionRoleModal, handleReactionRoleStringSelect };

// リアクションロールのボタン操作。

// ReactionRoleHandler が使う依存。
type ReactionRoleHandlerDeps = Pick<CoreDeps, "config" | "db" | "log" | "client">;

async function handleRoleToggle(interaction: ButtonInteraction, ctx: ReactionRoleHandlerDeps): Promise<void> {
  if (!interaction.guild) {
    await replyEphemeral(interaction, "Guild only");
    return;
  }
  const parsed = parseToggleCustomId(String(interaction.customId || ""));
  if (!parsed) {
    await replyEphemeral(interaction, "不正なボタンです。");
    return;
  }
  const entry = await getEntryByEntryId(ctx.db, interaction.guild.id, parsed.entryId);
  if (!entry || !entry.roles.some((item) => item.roleId === parsed.roleId)) {
    await replyEphemeral(interaction, "このボタンのロールは現在登録されていません。");
    return;
  }
  const roleId = parsed.roleId;
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
  if (role.managed || role.id === interaction.guild.id) {
    await replyEphemeral(interaction, "このロールは管理対象外のため変更できません。");
    return;
  }
  if (role.position >= me.roles.highest.position) {
    await replyEphemeral(interaction, "Bot のロール階層が不足しているため変更できません。");
    return;
  }
  const hasRole = member.roles.cache.has(role.id);
  if (!hasRole) {
    const dangerousPermissions = getDangerousReactionRolePermissionNames(role);
    if (dangerousPermissions.length > 0) {
      ctx.log.warn(
        {
          guildId: interaction.guild.id,
          entryId: parsed.entryId,
          roleId: role.id,
          permissions: dangerousPermissions,
        },
        "reaction role add blocked due to dangerous permissions",
      );
      await replyEphemeral(
        interaction,
        "このロールは強い権限を持つため、ボタンからは付与できません。サーバー管理者に連絡してください。",
      );
      return;
    }
  }
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

export async function handleReactionRoleButton(interaction: ButtonInteraction, ctx: ReactionRoleHandlerDeps): Promise<boolean> {
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

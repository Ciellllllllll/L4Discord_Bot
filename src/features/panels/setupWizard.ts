import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
} from "discord.js";
import { ulid } from "ulid";
import type { BotContext } from "../../bot/context.js";
import { createSession, deleteSession, getSession, mergeSessionPayload } from "../../core/interactionSessions.js";
import { isOwner } from "../../core/permission.js";
import { savePanelChannelsAndReconcile } from "./panelService.js";

export async function handleSetupUiOpenButton(interaction: ButtonInteraction, ctx: BotContext): Promise<boolean> {
  const parsed = interaction.customId.split(":");
  if (parsed.length < 3 || parsed[0] !== "panels" || parsed[1] !== "setupUi" || parsed[2] !== "open") {
    return false;
  }
  if (!interaction.guildId) {
    await interaction.reply({ content: "ギルド内でのみ実行できます。", ephemeral: true });
    return true;
  }
  if (!isOwner(interaction.user.id, ctx.config)) {
    await interaction.reply({ content: "OWNER 専用です。", ephemeral: true });
    return true;
  }
  await interaction.deferReply({ ephemeral: true });
  const sid = ulid();
  await createSession(ctx.db, {
    id: sid,
    guildId: interaction.guildId,
    domain: "panels",
    action: "panelChannelSetup",
    payload: { step: "pick_admin" },
    executorUserId: interaction.user.id,
    ttlHours: 1,
  });
  const row = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId(`panels:chAdm:${sid}`)
      .setPlaceholder("ADMIN用パネル（ログ・リアクションロール管理等）を置くチャンネル")
      .setMinValues(1)
      .setMaxValues(1)
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
  );
  await interaction.editReply({
    content:
      "**1/2** **ADMIN 用**パネルを設置するテキストチャンネルを選んでください（メッセージログ・リアクションロール管理パネルなど）。",
    components: [row],
  });
  return true;
}

export async function handleSetupChannelSelect(
  interaction: ChannelSelectMenuInteraction,
  ctx: BotContext,
): Promise<boolean> {
  const id = interaction.customId;
  if (!id.startsWith("panels:chAdm:") && !id.startsWith("panels:chUsr:")) return false;
  const isAdminPick = id.startsWith("panels:chAdm:");
  const sid = id.slice(isAdminPick ? "panels:chAdm:".length : "panels:chUsr:".length);

  await interaction.update({
    content: "処理しています…",
    components: [],
  });

  const session = await getSession(ctx.db, sid);
  const editWizard = async (content: string, components: ActionRowBuilder<ChannelSelectMenuBuilder>[]): Promise<void> => {
    await interaction.editReply({ content, components });
  };

  if (!session || session.executor_user_id !== interaction.user.id) {
    await editWizard("セッションが無効です。", []);
    return true;
  }
  if (!isOwner(interaction.user.id, ctx.config)) {
    await editWizard("OWNER 専用です。", []);
    return true;
  }
  const chId = interaction.values[0];
  if (!chId || !interaction.guildId) {
    await editWizard("チャンネルを選んでください。", []);
    return true;
  }

  if (isAdminPick) {
    await mergeSessionPayload(ctx.db, sid, { admin_channel_id: chId, step: "pick_user" });
    const row = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(`panels:chUsr:${sid}`)
        .setPlaceholder("USER用パネル（VC作成・Modmail等）を置くチャンネル")
        .setMinValues(1)
        .setMaxValues(1)
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    );
    await editWizard(
      "**2/2** **USER 用**パネルを設置するテキストチャンネルを選んでください（VC 作成・お問い合わせなど）。",
      [row],
    );
    return true;
  }

  const adminId = session.payload.admin_channel_id as string | undefined;
  if (!adminId) {
    await editWizard("セッションが壊れています。最初からやり直してください。", []);
    return true;
  }

  await savePanelChannelsAndReconcile(ctx, interaction.guildId, adminId, chId);
  await deleteSession(ctx.db, sid);
  await editWizard("送信先を保存し、常設パネルを同期しました（未送信のみ送信・既存メッセージは再利用します）。", []);
  return true;
}

export function buildSetupEntryButtonRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("panels:setupUi:open")
      .setLabel("送信先を設定")
      .setStyle(ButtonStyle.Primary),
  );
}

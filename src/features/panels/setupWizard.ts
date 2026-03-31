import {
  ActionRowBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
} from "discord.js";
import { ulid } from "ulid";
import type { BotContext } from "../../bot/context.js";
import { createSession, deleteSession, getSession, mergeSessionPayload } from "../../core/interactionSessions.js";
import { isAdmin } from "../../core/permission.js";
import { savePanelChannelTargets } from "./panelService.js";

export async function handleSetupHubButton(interaction: ButtonInteraction, ctx: BotContext): Promise<boolean> {
  const parsed = interaction.customId.split(":");
  if (parsed.length < 3 || parsed[0] !== "panels" || parsed[1] !== "setupHub") return false;
  const step = parsed[2];
  if (step !== "main") return false;
  const member = interaction.member && "roles" in interaction.member ? interaction.member : null;
  if (!isAdmin(member as never, ctx.config)) {
    await interaction.reply({ content: "権限がありません。", ephemeral: true });
    return true;
  }
  if (!interaction.guildId) {
    await interaction.reply({ content: "ギルド内でのみ実行できます。", ephemeral: true });
    return true;
  }
  await interaction.deferReply({ ephemeral: true });
  const sid = ulid();
  await createSession(ctx.db, {
    id: sid,
    guildId: interaction.guildId,
    domain: "panels",
    action: "setupWizard",
    payload: { step: "pick_admin" },
    executorUserId: interaction.user.id,
    ttlHours: 1,
  });
  const row = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId(`panels:chA:${sid}`)
      .setPlaceholder("ADMIN用パネルを置くテキストチャンネル")
      .setMinValues(1)
      .setMaxValues(1)
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
  );
  await interaction.editReply({
    content: "**ADMIN** 用パネルを設置するチャンネルを選んでください。",
    components: [row],
  });
  return true;
}

export async function handleSetupChannelSelect(
  interaction: ChannelSelectMenuInteraction,
  ctx: BotContext,
): Promise<boolean> {
  const id = interaction.customId;
  if (!id.startsWith("panels:chA:") && !id.startsWith("panels:chU:")) return false;
  const isAdminPick = id.startsWith("panels:chA:");
  const sid = id.slice(isAdminPick ? "panels:chA:".length : "panels:chU:".length);
  // deferUpdate は別プロセスと競合すると 10062 になり得る。先に update で ACK する。
  // エフェメラルは Message#edit（チャンネル PATCH）では 10008 になるため、editReply（@original）で更新する。
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
  const member = interaction.member && "roles" in interaction.member ? interaction.member : null;
  if (!isAdmin(member as never, ctx.config)) {
    await editWizard("権限がありません。", []);
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
        .setCustomId(`panels:chU:${sid}`)
        .setPlaceholder("USER用パネルを置くテキストチャンネル")
        .setMinValues(1)
        .setMaxValues(1)
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    );
    await editWizard("**USER** 用パネルを設置するチャンネルを選んでください。", [row]);
    return true;
  }
  const adminId = session.payload.admin_channel_id as string | undefined;
  if (!adminId) {
    await editWizard("セッションが壊れています。最初からやり直してください。", []);
    return true;
  }
  await savePanelChannelTargets(ctx, interaction.guildId, adminId, chId);
  await deleteSession(ctx.db, sid);
  await editWizard(
    "パネル設置チャンネルを保存し、パネルを送信しました（権限とBOT_VERSIONにより保留の場合は起動時に再試行されます）。",
    [],
  );
  return true;
}

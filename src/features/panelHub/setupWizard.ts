import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  MessageFlags,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
} from "discord.js";
import { randomUUID } from "node:crypto";
import type { CoreDeps } from "../../core/deps.js";
import { createSession, deleteSession, getSession, mergeSessionPayload } from "../../core/interactionSessions.js";
import { isOwner } from "../../core/permission.js";
import { savePanelChannelsAndReconcile } from "./panelService.js";

// SetupWizard が使う依存。
type SetupWizardDeps = Pick<CoreDeps, "config" | "db" | "log" | "client" | "aiHistoryDb" | "automodDb">;

function parseSetupChannelSelectId(id: string): { sid: string; step: "admin" | "vc" | "modmail" } | null {
  if (id.startsWith("panels:chAdm:")) {
    return { sid: id.slice("panels:chAdm:".length), step: "admin" };
  }
  if (id.startsWith("panels:chVc:")) {
    return { sid: id.slice("panels:chVc:".length), step: "vc" };
  }
  if (id.startsWith("panels:chMm:")) {
    return { sid: id.slice("panels:chMm:".length), step: "modmail" };
  }
  return null;
}

export async function handleSetupUiOpenButton(interaction: ButtonInteraction, ctx: SetupWizardDeps): Promise<boolean> {
  const parsed = interaction.customId.split(":");
  if (parsed.length < 3 || parsed[0] !== "panels" || parsed[1] !== "setupUi" || parsed[2] !== "open") {
    return false;
  }
  if (!interaction.guildId) {
    await interaction.reply({ content: "ギルド内でのみ実行できます。", flags: MessageFlags.Ephemeral });
    return true;
  }
  if (!isOwner(interaction.user.id, ctx.config)) {
    await interaction.reply({ content: "OWNER 専用です。", flags: MessageFlags.Ephemeral });
    return true;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const sid = randomUUID();
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
      "**1/3** **ADMIN 用**パネルを設置するテキストチャンネルを選んでください（メッセージログ・リアクションロール管理パネルなど）。",
    components: [row],
  });
  return true;
}

export async function handleSetupChannelSelect(
  interaction: ChannelSelectMenuInteraction,
  ctx: SetupWizardDeps,
): Promise<boolean> {
  const parsedId = parseSetupChannelSelectId(interaction.customId);
  if (!parsedId) return false;
  const { sid, step } = parsedId;

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

  if (step === "admin") {
    await mergeSessionPayload(ctx.db, sid, { admin_channel_id: chId, step: "pick_vc" });
    const row = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(`panels:chVc:${sid}`)
        .setPlaceholder("VC 仮チャンネル作成パネルを置くチャンネル")
        .setMinValues(1)
        .setMaxValues(1)
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    );
    await editWizard("**2/3** **VC 用**パネルを設置するテキストチャンネルを選んでください。", [row]);
    return true;
  }

  if (step === "vc") {
    await mergeSessionPayload(ctx.db, sid, { vc_channel_id: chId, step: "pick_modmail" });
    const row = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(`panels:chMm:${sid}`)
        .setPlaceholder("Modmail / お問い合わせパネルを置くチャンネル")
        .setMinValues(1)
        .setMaxValues(1)
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    );
    await editWizard("**3/3** **Modmail 用**パネルを設置するテキストチャンネルを選んでください。", [row]);
    return true;
  }

  const adminId = session.payload.admin_channel_id as string | undefined;
  const vcId = session.payload.vc_channel_id as string | undefined;
  if (!adminId || !vcId) {
    await editWizard("セッションが壊れています。最初からやり直してください。", []);
    return true;
  }

  await savePanelChannelsAndReconcile(ctx, interaction.guildId, adminId, vcId, chId);
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

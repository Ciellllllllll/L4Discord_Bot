import { ComponentCardBuilder, componentCardsPayload } from "../panels/componentCard.js";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { BotContext } from "../../bot/context.js";
import {
  buildAutoModPanelPayload,
  reconcileAutoModPanel,
  resolveAutoModAdminChannelId,
} from "./autoModerationPanel.js";
import { getMergedAutoModSettings, updateAutoModSettings } from "./autoModerationSettings.js";
import {
  AUTOMOD_RAID_CANCEL_PREFIX,
  AUTOMOD_RAID_CONFIRM_PREFIX,
  AUTOMOD_SELECT_PREFIX,
  PANEL_TOGGLE_OPTIONS,
} from "./autoModerationTypes.js";

export async function handleAutoModStringSelect(
  interaction: StringSelectMenuInteraction,
  ctx: BotContext,
): Promise<boolean> {
  if (!interaction.customId.startsWith(AUTOMOD_SELECT_PREFIX)) return false;
  const guildId = interaction.customId.slice(AUTOMOD_SELECT_PREFIX.length);
  if (!interaction.guild || interaction.guild.id !== guildId) {
    await interaction.reply({ content: "サーバーが一致しません。", flags: MessageFlags.Ephemeral });
    return true;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: "権限がありません。", flags: MessageFlags.Ephemeral });
    return true;
  }

  const current = await getMergedAutoModSettings(ctx, guildId);
  const selected = new Set(interaction.values);
  const nextState: Record<string, boolean> = {};
  for (const item of PANEL_TOGGLE_OPTIONS) {
    nextState[item.key] = selected.has(item.key);
  }

  const changedKeys = PANEL_TOGGLE_OPTIONS.map((item) => item.key).filter(
    (key) => Boolean(current[key as keyof typeof current]) !== Boolean(nextState[key]),
  );

  const raidModeChanged = changedKeys.includes("raidMode");
  const directPatch: Partial<typeof current> = {};
  for (const key of changedKeys) {
    if (key !== "raidMode") {
      (directPatch as Record<string, boolean>)[key] = nextState[key]!;
    }
  }

  if (Object.keys(directPatch).length > 0) {
    await updateAutoModSettings(ctx, guildId, directPatch);
  }

  const payload = await buildAutoModPanelPayload(ctx, guildId);
  await interaction.update(payload);

  if (raidModeChanged) {
    const nextEnabled = nextState.raidMode!;
    const confirmStyle = nextEnabled ? ButtonStyle.Danger : ButtonStyle.Primary;
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${AUTOMOD_RAID_CONFIRM_PREFIX}${guildId}:${nextEnabled ? "1" : "0"}`)
        .setLabel("承認")
        .setStyle(confirmStyle),
      new ButtonBuilder()
        .setCustomId(`${AUTOMOD_RAID_CANCEL_PREFIX}${guildId}`)
        .setLabel("キャンセル")
        .setStyle(ButtonStyle.Secondary),
    );
    await interaction.followUp({
      ...componentCardsPayload(
        [
          new ComponentCardBuilder()
          .setTitle("Raidモード変更の確認")
          .setDescription(
            `Raidモードを **${nextEnabled ? "有効化" : "無効化"}** しますか？\n承認ボタンを押すまで設定は反映されません。`,
          )
          .addFields({ name: "対象サーバーID", value: String(guildId), inline: false }),
        ],
        [row],
      ),
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
  }

  return true;
}

export async function handleAutoModRaidButton(interaction: ButtonInteraction, ctx: BotContext): Promise<boolean> {
  if (
    !interaction.customId.startsWith(AUTOMOD_RAID_CONFIRM_PREFIX) &&
    !interaction.customId.startsWith(AUTOMOD_RAID_CANCEL_PREFIX)
  ) {
    return false;
  }

  if (!interaction.guild) {
    await interaction.reply({ content: "サーバー情報を取得できませんでした。", flags: MessageFlags.Ephemeral });
    return true;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: "権限がありません。", flags: MessageFlags.Ephemeral });
    return true;
  }

  const gid = interaction.guild.id;

  if (interaction.customId.startsWith(AUTOMOD_RAID_CANCEL_PREFIX)) {
    const rest = interaction.customId.slice(AUTOMOD_RAID_CANCEL_PREFIX.length);
    if (rest !== gid) {
      await interaction.reply({ content: "サーバーが一致しません。", flags: MessageFlags.Ephemeral });
      return true;
    }
    await interaction.update({
      ...componentCardsPayload([
        new ComponentCardBuilder()
          .setTitle("Raidモード変更")
          .setDescription("操作をキャンセルしました。"),
      ]),
    });
    return true;
  }

  if (interaction.customId.startsWith(AUTOMOD_RAID_CONFIRM_PREFIX)) {
    const parts = interaction.customId.split(":");
    const guildId = parts[1] ?? "";
    const rawNext = parts[2] ?? "";
    if (guildId !== gid) {
      await interaction.reply({ content: "サーバーが一致しません。", flags: MessageFlags.Ephemeral });
      return true;
    }

    const nextEnabled = rawNext === "1";
    await updateAutoModSettings(ctx, guildId, { raidMode: nextEnabled });

    await interaction.update({
      ...componentCardsPayload([
        new ComponentCardBuilder()
          .setTitle("Raidモード変更")
          .setDescription(`Raidモードを **${nextEnabled ? "有効化" : "無効化"}** しました。`),
      ]),
    });

    const adminCh = await resolveAutoModAdminChannelId(ctx, guildId);
    if (adminCh) {
      await reconcileAutoModPanel(ctx, interaction.guild, adminCh).catch(() => undefined);
    }

    return true;
  }

  return false;
}

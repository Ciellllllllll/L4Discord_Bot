import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import { randomUUID } from "node:crypto";
import type { BotContext } from "../bot/context.js";
import { getGuildSettingsData } from "../core/guildSettings.js";
import { deleteSession, getSession } from "../core/interactionSessions.js";
import { parseCustomId } from "./parseCustomId.js";

export async function handlePanelButton(interaction: ButtonInteraction, _ctx: BotContext): Promise<boolean> {
  const parsed = parseCustomId(interaction.customId);
  if (!parsed || parsed.domain !== "panels") return false;
  await interaction.reply({ content: "セットアップパネルは準備中です。", ephemeral: true });
  return true;
}

const REASON_INPUT_ID = "detecter_reason_text";
const APPEAL_INPUT_ID = "appeal_text";

export async function handleDetecterButton(
  interaction: ButtonInteraction,
  ctx: BotContext,
): Promise<boolean> {
  const parsed = parseCustomId(interaction.customId);
  if (!parsed || parsed.domain !== "detecter") return false;

  if (parsed.action === "openReason") {
    const session = await getSession(ctx.db, parsed.shortId);
    if (!session || session.executor_user_id !== interaction.user.id) {
      await interaction.reply({ content: "この操作は実行できません。", ephemeral: true });
      return true;
    }
    const modal = new ModalBuilder()
      .setCustomId(`detecter:reasonModal:${parsed.shortId}`)
      .setTitle("処罰理由")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId(REASON_INPUT_ID)
            .setLabel("理由")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(1000),
        ),
      );
    await interaction.showModal(modal);
    return true;
  }

  if (parsed.action === "openAppeal") {
    const incidentId = parsed.shortId;
    const incident = await ctx.db
      .selectFrom("detecter_incidents")
      .select(["target_id"])
      .where("id", "=", incidentId)
      .executeTakeFirst();
    if (!incident || incident.target_id !== interaction.user.id) {
      await interaction.reply({ content: "この申請は対象者のみ利用できます。", ephemeral: true });
      return true;
    }
    const modal = new ModalBuilder()
      .setCustomId(`detecter:appealModal:${incidentId}`)
      .setTitle("解除申請")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId(APPEAL_INPUT_ID)
            .setLabel("申請内容")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(1000),
        ),
      );
    await interaction.showModal(modal);
    return true;
  }

  return false;
}

export async function routeButton(interaction: ButtonInteraction, ctx: BotContext): Promise<void> {
  if (await handleDetecterButton(interaction, ctx)) return;
  if (await handlePanelButton(interaction, ctx)) return;
}

export async function handleDetecterModal(
  interaction: ModalSubmitInteraction,
  ctx: BotContext,
): Promise<boolean> {
  const parsed = parseCustomId(interaction.customId);
  if (!parsed || parsed.domain !== "detecter") return false;

  if (parsed.action === "reasonModal") {
    const session = await getSession(ctx.db, parsed.shortId);
    if (!session || session.executor_user_id !== interaction.user.id) {
      await interaction.reply({ content: "セッションが無効です。", ephemeral: true });
      return true;
    }
    const p = session.payload as {
      auditEntryId: string;
      executorId: string;
      targetId: string;
      actionType: string;
    };
    const reason = interaction.fields.getTextInputValue(REASON_INPUT_ID);
    const row = await ctx.db
      .insertInto("detecter_incidents")
      .values({
        id: randomUUID(),
        guild_id: session.guild_id,
        audit_entry_id: String(p.auditEntryId),
        executor_id: p.executorId,
        target_id: p.targetId,
        action_type: p.actionType,
        reason,
        appeal_ticket_id: null,
        created_at: new Date(),
      })
      .returning("id")
      .executeTakeFirst();
    await deleteSession(ctx.db, parsed.shortId);

    const targetUser = await ctx.client.users.fetch(p.targetId).catch(() => null);
    const appealUrl = (await getGuildSettingsData(ctx.db, session.guild_id)).appeal_instructions_url;
    const embed = new EmbedBuilder()
      .setTitle("処罰のお知らせ")
      .setDescription(
        `理由:\n${reason.slice(0, 2000)}${appealUrl ? `\n\n案内: ${appealUrl}` : ""}`,
      );

    const appealRow = row
      ? new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`detecter:openAppeal:${row.id}`)
            .setLabel("解除申請する")
            .setStyle(ButtonStyle.Danger),
        )
      : null;

    if (targetUser) {
      try {
        await targetUser.send({
          embeds: [embed],
          components: appealRow ? [appealRow] : [],
        });
      } catch {
        ctx.log.warn({ targetId: p.targetId }, "detecter target DM failed");
      }
    }

    await interaction.reply({ content: "理由を記録し、対象者へ通知しました。", ephemeral: true });
    return true;
  }

  if (parsed.action === "appealModal") {
    const incidentId = parsed.shortId;
    const text = interaction.fields.getTextInputValue(APPEAL_INPUT_ID);
    await ctx.db
      .insertInto("tickets")
      .values({
        id: randomUUID(),
        guild_id: interaction.guildId ?? ctx.config.GUILD_ID,
        kind: "appeal",
        status: "open",
        opener_id: interaction.user.id,
        assignee_id: null,
        data: JSON.stringify({ incident_id: incidentId, body: text }) as unknown as Record<string, unknown>,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    await interaction.reply({ content: "解除申請を受け付けました。", ephemeral: true });
    return true;
  }

  return false;
}

export async function routeModal(interaction: ModalSubmitInteraction, ctx: BotContext): Promise<void> {
  if (await handleDetecterModal(interaction, ctx)) return;
}

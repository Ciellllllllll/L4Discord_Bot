import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { isAdmin } from "../../core/permission.js";
import {
  APPEAL_REASON_FIELD,
  APPEAL_START_PREFIX,
  APPEAL_SUBMIT_PREFIX,
} from "./appealConstants.js";
import {
  deletePendingAppealStartContext,
  getPendingAppealStartContext,
} from "./appealPending.js";
import {
  applyAppealApproveRemoveTimeout,
  buildThreadJumpRows,
  clearAppealStartButton,
  closeAppealReviewThread,
  createAppealHoldThread,
  createAppealRecord,
  extractAppealReviewContextFromMessage,
  formatUserRequesterInfo,
  getAppealById,
  notifyAppealUserResult,
  parseAppealReviewCustomId,
  patchAppeal,
  sendAppealReviewMessage,
} from "./appealService.js";

const reviewActionLocks = new Set<string>();

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

async function respondEphemeralOrEdit(
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

async function respondReviewEphemeral(interaction: ButtonInteraction, content: string): Promise<void> {
  try {
    if (interaction.deferred) {
      await interaction.editReply({ content });
      return;
    }
    if (interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  } catch {
    /* ignore */
  }
}

export async function handleAppealStartButton(interaction: ButtonInteraction, ctx: BotContext): Promise<boolean> {
  if (!interaction.customId.startsWith(APPEAL_START_PREFIX)) return false;

  const ctxId = interaction.customId.slice(APPEAL_START_PREFIX.length);
  const pending = getPendingAppealStartContext(ctxId);
  if (!pending) {
    await interaction.reply({
      content: "この異議申し立てボタンは期限切れです。",
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
      content: "この異議申し立てボタンはすでに使用済みです。",
      ...(interaction.guildId ? { flags: MessageFlags.Ephemeral } : {}),
    });
    return true;
  }

  pending.sourceChannelId = interaction.channelId;
  pending.sourceMessageId = interaction.message?.id ?? null;

  const modal = new ModalBuilder()
    .setCustomId(`${APPEAL_SUBMIT_PREFIX}${ctxId}`)
    .setTitle("異議申し立て")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(APPEAL_REASON_FIELD)
          .setLabel("申請理由")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1000)
          .setPlaceholder("処罰の見直しを希望する理由を記入してください。"),
      ),
    );

  try {
    await interaction.showModal(modal);
  } catch (e) {
    ctx.log.warn({ err: e }, "appeal: show modal failed");
    await interaction.reply({
      content: "モーダルの表示に失敗しました。時間をおいて再試行してください。",
      ...(interaction.guildId ? { flags: MessageFlags.Ephemeral } : {}),
    });
  }
  return true;
}

export async function handleAppealSubmitModal(interaction: ModalSubmitInteraction, ctx: BotContext): Promise<boolean> {
  if (!interaction.customId.startsWith(APPEAL_SUBMIT_PREFIX)) return false;

  const ctxId = interaction.customId.slice(APPEAL_SUBMIT_PREFIX.length);
  const pending = getPendingAppealStartContext(ctxId);
  if (!pending) {
    await respondEphemeralOrEdit(interaction, { content: "異議申し立て情報が期限切れです。" });
    return true;
  }
  if (interaction.user.id !== pending.userId) {
    await respondEphemeralOrEdit(interaction, { content: "このフォームは対象ユーザーのみ送信できます。" });
    return true;
  }
  if (pending.buttonFired) {
    await respondEphemeralOrEdit(interaction, { content: "この異議申し立てフォームはすでに送信済みです。" });
    return true;
  }

  pending.buttonFired = true;

  const deferred = await deferReplyGuildEphemeral(interaction);
  if (!deferred && !interaction.deferred && !interaction.replied) {
    pending.buttonFired = false;
    return true;
  }

  try {
    const reason = safeText(interaction.fields.getTextInputValue(APPEAL_REASON_FIELD), "-");
    const created = await createAppealRecord(ctx, pending, reason);

    if (pending.detecterIncidentId) {
      await ctx.db
        .updateTable("detecter_incidents")
        .set({ appeal_ticket_id: created.id })
        .where("id", "=", pending.detecterIncidentId)
        .execute();
    }

    await clearAppealStartButton(ctx, pending);

    const appeal = await getAppealById(ctx, created.id);
    if (!appeal) {
      throw new Error("appeal row missing after insert");
    }

    const requester = formatUserRequesterInfo(interaction.user, pending.guildId);
    const reviewMsg = await sendAppealReviewMessage(ctx, appeal, requester);
    if (!reviewMsg) {
      ctx.log.warn({ appealId: created.id }, "appeal: review channel message not sent (check APPEAL_REVIEW_CHANNEL_ID)");
    }

    deletePendingAppealStartContext(ctxId);
    await respondEphemeralOrEdit(interaction, {
      content: `異議申し立てを受け付けました。受付番号: ${created.code}`,
    });
  } catch (e) {
    pending.buttonFired = false;
    ctx.log.warn({ err: e }, "appeal: submit failed");
    await respondEphemeralOrEdit(interaction, {
      content: "異議申し立ての作成に失敗しました。時間をおいて再試行してください。",
    });
  }
  return true;
}

export async function handleAppealReviewButton(interaction: ButtonInteraction, ctx: BotContext): Promise<boolean> {
  const parsed = parseAppealReviewCustomId(interaction.customId);
  if (!parsed) return false;

  const { appealId, action, isThreadPanel } = parsed;

  if (!interaction.guildId || !interaction.member) {
    await interaction.reply({ content: "ギルド内でのみ利用できます。", ephemeral: true });
    return true;
  }

  const member = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  if (!member || !isAdmin(member, ctx.config)) {
    await interaction.reply({ content: "審査操作を行う権限がありません。", ephemeral: true });
    return true;
  }

  const reviewLockKey = `${interaction.customId}:${interaction.message?.id ?? ""}`;
  if (reviewActionLocks.has(reviewLockKey)) {
    await interaction.reply({ content: "この審査操作は現在処理中です。", ephemeral: true });
    return true;
  }
  reviewActionLocks.add(reviewLockKey);

  const deferred = await deferReplyGuildEphemeral(interaction);
  if (!deferred && !interaction.deferred && !interaction.replied) {
    reviewActionLocks.delete(reviewLockKey);
    return true;
  }

  try {
    const appeal = await getAppealById(ctx, appealId);
    if (!appeal) {
      await respondReviewEphemeral(interaction, "申請が見つかりません。");
      return true;
    }

    const reviewContext = extractAppealReviewContextFromMessage(interaction.message);
    const note = `reviewed by ${interaction.user.id}`;

    if (!isThreadPanel && action === "hold") {
      if (appeal.status !== "pending") {
        await respondReviewEphemeral(interaction, `この申請は既に ${appeal.status} です。`);
        return true;
      }

      const holdThreadResult = await createAppealHoldThread(interaction, ctx, appeal, {
        userId: reviewContext.userId || appeal.user_id,
        guildId: reviewContext.guildId || interaction.guildId || appeal.guild_id,
      });

      if (!holdThreadResult?.thread) {
        await respondReviewEphemeral(interaction, "保留スレッドの作成に失敗しました。");
        return true;
      }

      await patchAppeal(ctx, appealId, {
        status: "hold",
        reviewer_id: interaction.user.id,
        review_note: `${note} (hold)`,
      });

      const jumpRows = buildThreadJumpRows(
        interaction.guildId || reviewContext.guildId || appeal.guild_id,
        holdThreadResult.thread.id,
      );
      await interaction.message?.edit({ components: jumpRows }).catch(() => undefined);
      await notifyAppealUserResult(ctx, appeal, "hold", "審査は保留となり、スタッフが継続審査します。");
      await respondReviewEphemeral(interaction, `保留に変更しました。審査スレッド: <#${holdThreadResult.thread.id}>`);
      return true;
    }

    if (!["reject", "approve"].includes(action)) {
      await respondReviewEphemeral(interaction, "無効な操作です。");
      return true;
    }

    if (!["pending", "hold"].includes(appeal.status)) {
      await respondReviewEphemeral(interaction, `この申請は既に ${appeal.status} です。`);
      return true;
    }

    const nextStatus = action === "approve" ? "approved" : "rejected";

    if (nextStatus === "approved" && appeal.punishment_type === "timeout") {
      const gid = reviewContext.guildId || interaction.guildId || appeal.guild_id;
      const uid = reviewContext.userId || appeal.user_id;
      const untimeoutApplied = await applyAppealApproveRemoveTimeout(ctx, appeal, gid, uid);
      if (!untimeoutApplied) {
        await respondReviewEphemeral(interaction, "処罰解除に失敗しました。BOT の権限と対象ユーザー状態を確認してください。");
        return true;
      }
    }

    await patchAppeal(ctx, appealId, {
      status: nextStatus,
      reviewer_id: interaction.user.id,
      review_note: note,
    });

    await interaction.message?.edit({ components: [] }).catch(() => undefined);
    await notifyAppealUserResult(ctx, appeal, nextStatus, note);
    if (isThreadPanel && interaction.channel?.isThread()) {
      await closeAppealReviewThread(interaction.channel, `appeal ${appeal.code} ${nextStatus}`);
    }
    await respondReviewEphemeral(interaction, `申請 ${appeal.code} を ${nextStatus} に更新しました。`);
  } catch (e) {
    ctx.log.warn({ err: e }, "appeal: review failed");
    await respondReviewEphemeral(interaction, "申請の審査中にエラーが発生しました。");
  } finally {
    reviewActionLocks.delete(reviewLockKey);
  }
  return true;
}

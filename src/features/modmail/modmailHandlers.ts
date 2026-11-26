import { randomBytes } from "node:crypto";
import { MessageFlags, type ButtonInteraction } from "discord.js";
import type { CoreDeps } from "../../core/deps.js";
import { buildModmailTicketCreateRow } from "./modmailUi.js";
import { openModmailByGuildUser, sendModmailStartDm, upsertModmailIntake } from "./modmailService.js";
import { pendingModmailTicketContexts } from "./modmailSessions.js";

export async function handleUserPanelModmailStart(
  interaction: ButtonInteraction,
  ctx: Pick<CoreDeps, "ticketDb" | "log">,
): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "ギルド内でのみ利用できます。", flags: MessageFlags.Ephemeral });
    return;
  }
  const guildId = interaction.guildId;
  const uid = interaction.user.id;

  const open = await openModmailByGuildUser(ctx, guildId, uid);
  if (open) {
    await interaction.reply({
      content: "現在対応中のチケットがあります。新規作成はできません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const ctxId = `${Date.now()}_${randomBytes(4).toString("hex")}`;
  pendingModmailTicketContexts.set(ctxId, {
    createdAt: Date.now(),
    guildId,
    userId: uid,
    buttonFired: false,
  });

  try {
    await upsertModmailIntake(ctx, guildId, uid);
    await sendModmailStartDm(interaction.user, [buildModmailTicketCreateRow(ctxId)]);
    await interaction.reply({
      content:
        "DM を送信しました。DM の「チケットを作成」から内容を入力して受付を開始してください。",
      flags: MessageFlags.Ephemeral,
    });
  } catch (e) {
    pendingModmailTicketContexts.delete(ctxId);
    ctx.log.warn({ err: e, guildId, userId: uid }, "modmail start DM failed");
    await interaction.reply({
      content: "Bot から DM を送信できませんでした。Bot の DM を受け取れる設定にしてください。",
      flags: MessageFlags.Ephemeral,
    });
  }
}

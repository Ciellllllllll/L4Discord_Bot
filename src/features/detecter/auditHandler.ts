import {
  ActionRowBuilder,
  AuditLogEvent,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type Client,
  type GuildAuditLogsEntry,
} from "discord.js";
import { ulid } from "ulid";
import type { BotContext } from "../../bot/context.js";
import { createSession } from "../../core/interactionSessions.js";
import { isAdmin, memberIsModerator } from "../../core/permission.js";
import { consumeAuditKey } from "./dedupe.js";

function isTimeoutEntry(entry: GuildAuditLogsEntry): boolean {
  if (entry.action !== AuditLogEvent.MemberUpdate) return false;
  return Boolean(
    entry.changes?.some((c) => c.key === "communication_disabled_until" && c.new != null),
  );
}

function detecterActionLabel(entry: GuildAuditLogsEntry): string | null {
  if (entry.action === AuditLogEvent.MemberKick) return "kick";
  if (entry.action === AuditLogEvent.MemberBanAdd) return "ban";
  if (isTimeoutEntry(entry)) return "timeout";
  return null;
}

async function executorIsRelevantStaff(
  guild: import("discord.js").Guild,
  executorId: string,
  ctx: BotContext,
): Promise<boolean> {
  if (executorId === guild.ownerId) return true;
  const m = await guild.members.fetch(executorId).catch(() => null);
  if (!m) return false;
  return isAdmin(m, ctx.config) || memberIsModerator(m);
}

export async function handleAuditLogEntry(
  entry: GuildAuditLogsEntry,
  guild: import("discord.js").Guild,
  client: Client,
  ctx: BotContext,
): Promise<void> {
  if (guild.id !== ctx.config.GUILD_ID) return;
  const dedupeKey = `${guild.id}:${entry.id}`;
  if (!consumeAuditKey(dedupeKey)) return;
  const actionType = detecterActionLabel(entry);
  if (!actionType) return;
  const executorId = entry.executorId;
  if (!executorId || executorId === client.user?.id) return;
  const target = entry.target;
  if (!target || !("id" in target)) return;
  const targetId = target.id;
  const ok = await executorIsRelevantStaff(guild, executorId, ctx);
  if (!ok) return;

  const sessionId = ulid();
  await createSession(ctx.db, {
    id: sessionId,
    guildId: guild.id,
    domain: "detecter",
    action: "reason",
    payload: {
      auditEntryId: entry.id,
      executorId,
      targetId,
      actionType,
    },
    executorUserId: executorId,
  });

  const embed = new EmbedBuilder()
    .setTitle("処罰理由の入力")
    .setDescription(
      `対象: <@${targetId}>（${actionType}）\n下のボタンから理由を送信してください。`,
    )
    .setFooter({ text: `audit: ${entry.id}` });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`detecter:openReason:${sessionId}`)
      .setLabel("理由を入力")
      .setStyle(ButtonStyle.Primary),
  );

  const executorUser = await client.users.fetch(executorId).catch(() => null);
  if (executorUser) {
    try {
      await executorUser.send({ embeds: [embed], components: [row] });
      return;
    } catch {
      ctx.log.warn({ executorId }, "detecter mod DM failed");
    }
  }

  const fb = ctx.config.DETECTER_FALLBACK_CHANNEL_ID;
  if (fb) {
    const ch = await guild.channels.fetch(fb).catch(() => null);
    if (ch?.isTextBased()) {
      await ch.send({
        content: `<@${executorId}>`,
        embeds: [embed],
        components: [row],
      });
    }
  }
}

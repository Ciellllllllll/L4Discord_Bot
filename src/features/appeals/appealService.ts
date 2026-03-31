import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type ButtonInteraction,
  type Guild,
  type Message,
  type NewsChannel,
  type TextChannel,
  type ThreadChannel,
  type User,
} from "discord.js";
import { randomUUID } from "node:crypto";
import type { BotContext } from "../../bot/context.js";
import { sqliteTimestamp } from "../../core/db/sqliteTimestamp.js";
import type { AppealsRow } from "../../core/db/types.js";
import {
  APPEAL_REVIEW_PREFIX,
  APPEAL_REVIEW_THREAD_PREFIX,
  resolveAppealReviewChannelId,
} from "./appealConstants.js";
import type { PendingAppealStartCtx } from "./appealPending.js";

function safeText(value: unknown, fallback = "-"): string {
  const t = value === null || value === undefined ? "" : String(value).trim();
  return t || fallback;
}

export function parseAppealReviewCustomId(customId: string): {
  appealId: string;
  action: string;
  isThreadPanel: boolean;
} | null {
  if (customId.startsWith(APPEAL_REVIEW_THREAD_PREFIX)) {
    const rest = customId.slice(APPEAL_REVIEW_THREAD_PREFIX.length);
    const lastPipe = rest.lastIndexOf("|");
    if (lastPipe <= 0) return null;
    const appealId = rest.slice(0, lastPipe);
    const action = rest.slice(lastPipe + 1);
    if (!appealId || !action) return null;
    return { appealId, action, isThreadPanel: true };
  }
  if (customId.startsWith(APPEAL_REVIEW_PREFIX)) {
    const rest = customId.slice(APPEAL_REVIEW_PREFIX.length);
    const lastPipe = rest.lastIndexOf("|");
    if (lastPipe <= 0) return null;
    const appealId = rest.slice(0, lastPipe);
    const action = rest.slice(lastPipe + 1);
    if (!appealId || !action) return null;
    return { appealId, action, isThreadPanel: false };
  }
  return null;
}

export function buildAppealReviewRows(appealId: string): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${APPEAL_REVIEW_PREFIX}${appealId}|hold`)
        .setLabel("保留")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`${APPEAL_REVIEW_PREFIX}${appealId}|reject`)
        .setLabel("却下")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`${APPEAL_REVIEW_PREFIX}${appealId}|approve`)
        .setLabel("承認")
        .setStyle(ButtonStyle.Success),
    ),
  ];
}

export function buildAppealThreadReviewRows(appealId: string): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${APPEAL_REVIEW_THREAD_PREFIX}${appealId}|reject`)
        .setLabel("却下")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`${APPEAL_REVIEW_THREAD_PREFIX}${appealId}|approve`)
        .setLabel("承認")
        .setStyle(ButtonStyle.Success),
    ),
  ];
}

export function buildThreadJumpRows(guildId: string, threadId: string): ActionRowBuilder<ButtonBuilder>[] {
  const url = `https://discord.com/channels/${guildId}/${threadId}`;
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel("対応する（スレッドに移動する）")
        .setURL(url),
    ),
  ];
}

export async function createAppealRecord(
  ctx: BotContext,
  pending: PendingAppealStartCtx,
  appealReason: string,
): Promise<{ id: string; code: string }> {
  const id = randomUUID();
  const code = `AP-${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
  await ctx.db
    .insertInto("appeals")
    .values({
      id,
      code,
      guild_id: pending.guildId,
      user_id: pending.userId,
      punishment_type: safeText(pending.punishmentType, "unknown"),
      punishment_reason: safeText(pending.punishmentReason, "-"),
      timeout_start: pending.timeoutStart,
      timeout_end: pending.timeoutEnd,
      status: "pending",
      appeal_reason: safeText(appealReason, "-"),
      detecter_incident_id: pending.detecterIncidentId,
      created_at: sqliteTimestamp() as unknown as Date,
      updated_at: sqliteTimestamp() as unknown as Date,
      reviewer_id: null,
      review_note: null,
      review_message_id: null,
    })
    .execute();
  return { id, code };
}

export async function getAppealById(ctx: BotContext, appealId: string): Promise<AppealsRow | undefined> {
  const row = await ctx.db.selectFrom("appeals").selectAll().where("id", "=", appealId).executeTakeFirst();
  return row;
}

export async function patchAppeal(
  ctx: BotContext,
  appealId: string,
  patch: Partial<{
    status: string;
    reviewer_id: string | null;
    review_note: string | null;
    review_message_id: string | null;
  }>,
): Promise<void> {
  await ctx.db
    .updateTable("appeals")
    .set({ ...patch, updated_at: sqliteTimestamp() as unknown as Date })
    .where("id", "=", appealId)
    .execute();
}

export async function clearAppealStartButton(ctx: BotContext, pending: PendingAppealStartCtx): Promise<void> {
  if (!pending.sourceChannelId || !pending.sourceMessageId) return;
  let channel = ctx.client.channels.cache.get(pending.sourceChannelId);
  if (!channel) {
    channel = (await ctx.client.channels.fetch(pending.sourceChannelId).catch(() => null)) ?? undefined;
  }
  if (!channel?.isTextBased()) return;
  const msg = await (channel as TextChannel).messages.fetch(pending.sourceMessageId).catch(() => null);
  if (!msg) return;
  await msg.edit({ components: [] }).catch(() => undefined);
}

export async function sendAppealReviewMessage(
  ctx: BotContext,
  appeal: AppealsRow,
  requester: { tag: string; displayName: string; userId: string; guildId: string },
): Promise<Message | null> {
  const chId = resolveAppealReviewChannelId(ctx.config);
  if (!chId) {
    ctx.log.warn({}, "appeal: APPEAL_REVIEW_CHANNEL_ID (or fallback log channel) is not set");
    return null;
  }

  let channel = ctx.client.channels.cache.get(chId);
  if (!channel) {
    channel = (await ctx.client.channels.fetch(chId).catch(() => null)) ?? undefined;
  }
  if (!channel?.isTextBased()) {
    ctx.log.warn({ chId }, "appeal: review channel not found or not text-based");
    return null;
  }

  const embed = new EmbedBuilder()
    .setTitle(`異議申し立て ${appeal.code}`)
    .setDescription("以下の内容を確認し、ボタンで審査してください。")
    .setColor(0xe67e22)
    .addFields(
      { name: "申請者", value: `${requester.displayName} (${requester.tag})`, inline: false },
      { name: "処罰タイプ", value: safeText(appeal.punishment_type, "-"), inline: true },
      {
        name: "終了時刻",
        value: appeal.timeout_end ? `<t:${appeal.timeout_end}:F>` : "-",
        inline: true,
      },
      {
        name: "処罰理由",
        value: safeText(appeal.punishment_reason, "-").slice(0, 1000),
        inline: false,
      },
      {
        name: "申請理由",
        value: safeText(appeal.appeal_reason, "-").slice(0, 1000),
        inline: false,
      },
    )
    .setFooter({
      text: `appeal_id=${appeal.id} user_id=${requester.userId} guild_id=${requester.guildId}`,
    })
    .setTimestamp(new Date());

  const rows = buildAppealReviewRows(appeal.id);
  const sent = await (channel as TextChannel).send({ embeds: [embed], components: rows });
  await ctx.db
    .updateTable("appeals")
    .set({
      review_message_id: sent.id,
      updated_at: sqliteTimestamp() as unknown as Date,
    })
    .where("id", "=", appeal.id)
    .execute();
  return sent;
}

export async function notifyAppealUserResult(
  ctx: BotContext,
  appeal: AppealsRow,
  result: string,
  note: string,
): Promise<void> {
  const user = await ctx.client.users.fetch(appeal.user_id).catch(() => null);
  if (!user) return;

  const color =
    result === "approved" ? 0x2ecc71 : result === "rejected" ? 0xe74c3c : result === "hold" ? 0x95a5a6 : 0x95a5a6;
  const embed = new EmbedBuilder()
    .setTitle(`異議申し立て ${appeal.code}`)
    .setColor(color)
    .addFields(
      { name: "結果", value: result, inline: true },
      { name: "コメント", value: safeText(note, "-"), inline: false },
    )
    .setTimestamp(new Date());

  await user.send({ embeds: [embed] }).catch(() => undefined);
}

export function extractAppealReviewContextFromMessage(message: Message | null): {
  userId: string;
  guildId: string;
} {
  const embed = message?.embeds?.[0];
  const footerText = safeText(embed?.footer?.text, "");
  const userMatch = /user_id=(\d+)/.exec(footerText);
  const guildMatch = /guild_id=(\d+)/.exec(footerText);
  let userId = userMatch?.[1]?.trim() ?? "";
  const guildId = guildMatch?.[1]?.trim() ?? "";
  if (!userId) {
    const applicantField = safeText(embed?.fields?.[0]?.value, "");
    const mentionMatch = /<@!?(\d+)>/.exec(applicantField);
    userId = mentionMatch?.[1]?.trim() ?? "";
  }
  return { userId, guildId };
}

async function forceAddRoleMembersToThread(guild: Guild, thread: ThreadChannel, roleId: string): Promise<void> {
  const role = guild.roles.cache.get(roleId);
  if (!role) return;
  for (const memberId of role.members.keys()) {
    await thread.members.add(memberId).catch(() => undefined);
  }
}

export async function applyAppealApproveRemoveTimeout(
  ctx: BotContext,
  appeal: AppealsRow,
  guildId: string,
  userId: string,
): Promise<boolean> {
  if (appeal.punishment_type !== "timeout") return false;

  let guild = ctx.client.guilds.cache.get(guildId);
  if (!guild) guild = (await ctx.client.guilds.fetch(guildId).catch(() => null)) ?? undefined;
  if (!guild) return false;

  const member =
    guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null)) ?? null;
  if (!member) return false;

  try {
    await member.timeout(null, `appeal approved ${appeal.code}`);
    return true;
  } catch (e) {
    ctx.log.warn({ err: e }, "appeal: failed to remove timeout on approve");
    return false;
  }
}

export async function createAppealHoldThread(
  interaction: ButtonInteraction,
  ctx: BotContext,
  appeal: AppealsRow,
  reviewContext: { userId: string; guildId: string },
): Promise<{ thread: ThreadChannel; panel: Message } | null> {
  const parent = interaction.channel;
  const guild = interaction.guild;
  if (!parent?.isTextBased() || !guild) return null;

  const textParent = parent as TextChannel | NewsChannel;

  let thread: ThreadChannel | null = null;
  try {
    const seed = await textParent.send({
      content: `Appeal Hold #${appeal.code}`,
      allowedMentions: { parse: [] },
    });
    thread = await seed.startThread({
      name: `appeal-${appeal.code}-hold`,
      autoArchiveDuration: 1440,
      reason: `appeal hold ${appeal.code}`,
    });
    await seed.delete().catch(() => undefined);
  } catch (e) {
    ctx.log.warn({ err: e }, "appeal: failed to create hold thread from seed");
    if (textParent.threads?.create) {
      thread = await textParent.threads
        .create({
          name: `appeal-${appeal.code}-hold`,
          autoArchiveDuration: 1440,
          reason: `appeal hold ${appeal.code}`,
        })
        .catch(() => null);
    }
  }

  if (!thread?.isTextBased()) return null;

  const adminRoleId = ctx.config.ADMIN_ROLE_ID?.trim();
  if (adminRoleId) {
    await thread
      .send({
        content: `<@&${adminRoleId}>`,
        allowedMentions: { roles: [adminRoleId], parse: [] },
      })
      .catch(() => undefined);
    await forceAddRoleMembersToThread(guild, thread, adminRoleId);
  }

  const holdEmbed = new EmbedBuilder()
    .setTitle(`異議申し立て ${appeal.code}（保留審査）`)
    .setDescription("保留審査スレッドです。内容を確認して却下または承認を選択してください。")
    .setColor(0xf1c40f)
    .addFields(
      { name: "申請者", value: `<@${reviewContext.userId || appeal.user_id}>`, inline: false },
      { name: "処罰タイプ", value: safeText(appeal.punishment_type, "-"), inline: true },
      {
        name: "終了時刻",
        value: appeal.timeout_end ? `<t:${appeal.timeout_end}:F>` : "-",
        inline: true,
      },
      {
        name: "処罰理由",
        value: safeText(appeal.punishment_reason, "-").slice(0, 1000),
        inline: false,
      },
      {
        name: "申請理由",
        value: safeText(appeal.appeal_reason, "-").slice(0, 1000),
        inline: false,
      },
    )
    .setFooter({
      text: `appeal_id=${appeal.id} user_id=${reviewContext.userId || appeal.user_id} guild_id=${reviewContext.guildId || guild.id}`,
    })
    .setTimestamp(new Date());

  const panel = await thread
    .send({
      embeds: [holdEmbed],
      components: buildAppealThreadReviewRows(appeal.id),
      allowedMentions: { parse: [] },
    })
    .catch(() => null);
  if (!panel) return null;

  return { thread, panel };
}

export async function closeAppealReviewThread(channel: ThreadChannel, reason: string): Promise<void> {
  const closeReason = safeText(reason, "appeal review closed");
  await channel.setArchived(true, closeReason).catch(() => undefined);
  await channel.setLocked(true, closeReason).catch(() => undefined);
}

export function formatUserRequesterInfo(user: User, guildId: string): {
  tag: string;
  displayName: string;
  userId: string;
  guildId: string;
} {
  return {
    tag: user.username,
    displayName: safeText(user.globalName ?? user.username, user.username),
    userId: user.id,
    guildId,
  };
}

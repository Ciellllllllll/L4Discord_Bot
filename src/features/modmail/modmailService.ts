import { randomUUID } from "node:crypto";
import {
  ChannelType,
  EmbedBuilder,
  type Guild,
  type Message,
  type NewsChannel,
  type TextChannel,
  type ThreadChannel,
  type User,
} from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { sqliteTimestamp } from "../../core/db/sqliteTimestamp.js";
import {
  attachmentMetaToJson,
  buildForwardDmFiles,
  type AttachmentMeta,
} from "./modmailAttachmentUtils.js";
import { resolveModmailParentChannelId } from "./modmailConstants.js";
import { logModmailEvent } from "./modmailEventsLog.js";
import { buildModmailCloseRow } from "./modmailUi.js";

// select 結果（Kysely の ColumnType と整合させるためのランタイム行型）

export type ModmailThreadRow = {
  id: string;
  guild_id: string;
  user_id: string;
  channel_id: string | null;
  thread_id: string | null;
  status: string;
  data: unknown;
  created_at: Date;
};

type RelayChannel = TextChannel | NewsChannel | ThreadChannel;

const INTAKE_PENDING = "PendingFirstMessage";
const INTAKE_CONSUMED = "Consumed";
const MM_OPEN = "open";
export const MM_CLOSED = "closed";

function trimMax(text: string, n: number): string {
  const s = text.trim();
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

export function ticketDisplayCode(id: unknown): string {
  return String(id).replace(/-/g, "").slice(0, 8).toUpperCase();
}

export function parseModmailRowData(data: unknown): Record<string, unknown> {
  if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
  if (typeof data === "string") {
    try {
      const p = JSON.parse(data) as unknown;
      if (p && typeof p === "object" && !Array.isArray(p)) return p as Record<string, unknown>;
    } catch {}
  }
  return {};
}

function formatDiscordTime(isoOrDate: string | Date): string {
  const ms = new Date(isoOrDate).getTime();
  if (!Number.isFinite(ms)) return String(isoOrDate);
  return `<t:${Math.floor(ms / 1000)}:F>`;
}

function splitDiscord(text: string, n = 1900): string[] {
  const src = text.trim();
  if (!src) return [""];
  const out: string[] = [];
  let left = src;
  while (left.length > n) {
    let cut = left.lastIndexOf("\n", n);
    if (cut <= 0) cut = n;
    out.push(left.slice(0, cut));
    left = left.slice(cut).replace(/^\n+/, "");
  }
  out.push(left);
  return out;
}

async function sendLong(channel: RelayChannel, text: string): Promise<void> {
  for (const chunk of splitDiscord(text)) {
    await channel.send({ content: chunk || " ", allowedMentions: { parse: [] } });
  }
}

function serializeAttachments(message: Message): { name: string | null; url: string | null; size: number | null }[] {
  const out: { name: string | null; url: string | null; size: number | null }[] = [];
  for (const a of message.attachments.values()) {
    out.push({
      name: a.name ?? null,
      url: a.url ?? null,
      size: Number.isFinite(a.size) ? a.size : null,
    });
  }
  return out;
}

async function forceAddRoleMembersToThread(guild: Guild, threadId: string, roleId: string): Promise<void> {
  const role =
    guild.roles.cache.get(roleId) ?? (await guild.roles.fetch(roleId).catch(() => null));
  if (!role) return;
  if (role.members.size === 0) await guild.members.fetch().catch(() => undefined);
  const ch = await guild.channels.fetch(threadId).catch(() => null);
  if (!ch?.isThread()) return;
  for (const memberId of role.members.keys()) {
    await ch.members.add(String(memberId)).catch(() => undefined);
  }
}

export function buildModmailThreadSummaryEmbed(row: ModmailThreadRow, data: Record<string, unknown>): EmbedBuilder {
  const code = ticketDisplayCode(row.id);
  const subject = trimMax(String(data.subject ?? "(未設定)"), 1024);
  const body = trimMax(String(data.body ?? "(本文なし)"), 1024);
  return new EmbedBuilder()
    .setTitle(`Modmail-${code}_対応中`)
    .setColor(0x3498db)
    .addFields(
      { name: "チケットID", value: code, inline: true },
      { name: "チケット作成日時", value: formatDiscordTime(row.created_at), inline: true },
      { name: "タイトル", value: subject, inline: false },
      { name: "相談内容", value: body, inline: false },
      { name: "現在状態", value: row.status || MM_OPEN, inline: true },
      { name: "クローズ操作", value: "下のボタンからチケットをクローズできます。", inline: false },
    )
    .setTimestamp(new Date());
}

function buildParentTicketEmbed(row: ModmailThreadRow, data: Record<string, unknown>): EmbedBuilder {
  const code = ticketDisplayCode(row.id);
  const title = trimMax(String(data.subject ?? `Modmail-${code}`), 256);
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(`Modmail-${code}_対応中`)
    .setColor(0x2ecc71)
    .setTimestamp(new Date());
}

export async function upsertModmailIntake(ctx: BotContext, guildId: string, userId: string): Promise<void> {
  const ts = sqliteTimestamp();
  await ctx.ticketDb
    .insertInto("modmail_intakes")
    .values({
      guild_id: guildId,
      user_id: userId,
      status: INTAKE_PENDING,
      requested_at: ts as unknown as Date,
      dm_sent_at: ts as unknown as Date,
      updated_at: ts as unknown as Date,
    })
    .onConflict((oc) =>
      oc.columns(["guild_id", "user_id"]).doUpdateSet({
        status: INTAKE_PENDING,
        requested_at: ts as unknown as Date,
        dm_sent_at: ts as unknown as Date,
        updated_at: ts as unknown as Date,
      }),
    )
    .execute();
}

export async function consumeModmailIntake(ctx: BotContext, guildId: string, userId: string): Promise<void> {
  const ts = sqliteTimestamp();
  await ctx.ticketDb
    .updateTable("modmail_intakes")
    .set({
      status: INTAKE_CONSUMED,
      updated_at: ts as unknown as Date,
    })
    .where("guild_id", "=", guildId)
    .where("user_id", "=", userId)
    .execute();
}

export async function activeIntakeByGuildUser(
  ctx: BotContext,
  guildId: string,
  userId: string,
): Promise<boolean> {
  const row = await ctx.ticketDb
    .selectFrom("modmail_intakes")
    .select(["guild_id"])
    .where("guild_id", "=", guildId)
    .where("user_id", "=", userId)
    .where("status", "=", INTAKE_PENDING)
    .executeTakeFirst();
  return Boolean(row);
}

export async function activeIntakeByUser(ctx: BotContext, userId: string): Promise<{ guild_id: string } | null> {
  const row = await ctx.ticketDb
    .selectFrom("modmail_intakes")
    .select(["guild_id"])
    .where("user_id", "=", userId)
    .where("status", "=", INTAKE_PENDING)
    .orderBy("updated_at", "desc")
    .executeTakeFirst();
  return row ?? null;
}

export async function getOpenModmailByThreadId(
  ctx: BotContext,
  threadId: string,
): Promise<ModmailThreadRow | undefined> {
  const row = await ctx.ticketDb
    .selectFrom("modmail_threads")
    .selectAll()
    .where("thread_id", "=", threadId)
    .where("status", "=", MM_OPEN)
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  return row as ModmailThreadRow | undefined;
}

export async function openModmailByGuildUser(
  ctx: BotContext,
  guildId: string,
  userId: string,
): Promise<ModmailThreadRow | undefined> {
  const row = await ctx.ticketDb
    .selectFrom("modmail_threads")
    .selectAll()
    .where("guild_id", "=", guildId)
    .where("user_id", "=", userId)
    .where("status", "=", MM_OPEN)
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  return row as ModmailThreadRow | undefined;
}

export async function anyOpenModmailByUser(
  ctx: BotContext,
  userId: string,
): Promise<ModmailThreadRow | undefined> {
  const row = await ctx.ticketDb
    .selectFrom("modmail_threads")
    .selectAll()
    .where("user_id", "=", userId)
    .where("status", "=", MM_OPEN)
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  return row as ModmailThreadRow | undefined;
}

async function createModmailSkeleton(
  ctx: BotContext,
  guildId: string,
  userId: string,
  body: string,
  subject: string | null,
  firstDmMessageId: string | null,
  source: string,
): Promise<string> {
  const id = randomUUID();
  const ts = sqliteTimestamp();
  const data = {
    body: trimMax(body, 1000),
    subject: subject ? trimMax(subject, 120) : null,
    source,
    first_user_dm_message_id: firstDmMessageId,
  };
  await ctx.ticketDb
    .insertInto("modmail_threads")
    .values({
      id,
      guild_id: guildId,
      user_id: userId,
      channel_id: null,
      thread_id: null,
      status: MM_OPEN,
      data: JSON.stringify(data) as unknown as Record<string, unknown>,
      created_at: ts as unknown as Date,
    })
    .execute();
  return id;
}

async function deleteModmailById(ctx: BotContext, id: string): Promise<void> {
  await ctx.ticketDb.deleteFrom("modmail_threads").where("id", "=", id).execute();
}

async function updateModmailThreadMeta(
  ctx: BotContext,
  id: string,
  parentChannelId: string,
  threadId: string,
  dataPatch: Record<string, unknown>,
): Promise<void> {
  const row = await ctx.ticketDb.selectFrom("modmail_threads").selectAll().where("id", "=", id).executeTakeFirst();
  if (!row) return;
  const merged = { ...parseModmailRowData(row.data), ...dataPatch };
  await ctx.ticketDb
    .updateTable("modmail_threads")
    .set({
      channel_id: parentChannelId,
      thread_id: threadId,
      data: JSON.stringify(merged) as unknown as Record<string, unknown>,
    })
    .where("id", "=", id)
    .execute();
}

export async function getModmailTicketRow(ctx: BotContext, id: string): Promise<ModmailThreadRow | undefined> {
  const row = await ctx.ticketDb.selectFrom("modmail_threads").selectAll().where("id", "=", id).executeTakeFirst();
  return row as ModmailThreadRow | undefined;
}

async function fetchModmailRow(ctx: BotContext, id: string): Promise<ModmailThreadRow | undefined> {
  return getModmailTicketRow(ctx, id);
}

export async function closeModmailTicketInDb(
  ctx: BotContext,
  ticketId: string,
  closerId: string,
  reason: string,
): Promise<{ ok: boolean; closedAt?: string }> {
  const row = await fetchModmailRow(ctx, ticketId);
  if (!row || row.status !== MM_OPEN) return { ok: false };
  const merged = {
    ...parseModmailRowData(row.data),
    closed_at: sqliteTimestamp(),
    close_reason: reason,
    closer_staff_id: closerId,
  };
  const result = await ctx.ticketDb
    .updateTable("modmail_threads")
    .set({
      status: MM_CLOSED,
      data: JSON.stringify(merged) as unknown as Record<string, unknown>,
    })
    .where("id", "=", ticketId)
    .where("status", "=", MM_OPEN)
    .executeTakeFirst();
  const n = Number(result.numUpdatedRows ?? 0);
  if (n === 0) return { ok: false };
  return { ok: true, closedAt: merged.closed_at as string };
}

type StaffThreadResult = { threadId: string; summaryMessageId: string };

async function createStaffThread(
  ctx: BotContext,
  guild: Guild,
  row: ModmailThreadRow,
): Promise<StaffThreadResult | null> {
  const parentId = resolveModmailParentChannelId(ctx.config);
  if (!parentId) return null;

  let parent =
    guild.channels.cache.get(parentId) ?? (await guild.channels.fetch(parentId).catch(() => null));
  if (!parent) return null;

  const data = parseModmailRowData(row.data);
  const code = ticketDisplayCode(row.id);
  const tname = `Modmail-${code}_対応中`.slice(0, 100);
  const summaryEmbed = buildModmailThreadSummaryEmbed(row, data);
  const summaryPayload = {
    embeds: [summaryEmbed],
    components: [buildModmailCloseRow(row.id)],
    allowedMentions: { parse: [] } as const,
  };

  const adminRoleId = ctx.config.ADMIN_ROLE_ID?.trim();

  if (parent.type === ChannelType.GuildText || parent.type === ChannelType.GuildAnnouncement) {
    if (!parent.isTextBased()) return null;
    const seed = await parent
      .send({
        content: `Modmail Ticket #${code}`,
        allowedMentions: { parse: [] },
      })
      .catch(() => null);
    if (!seed) return null;

    const thread = await seed
      .startThread({
        name: tname,
        autoArchiveDuration: 1440,
        reason: "modmail ticket",
      })
      .catch(() => null);
    await seed.delete().catch(() => undefined);
    if (!thread?.isTextBased()) return null;
    const summaryMessage = await (thread as RelayChannel).send(summaryPayload).catch(() => null);
    if (!summaryMessage) return null;

    const noticePayload: {
      content?: string;
      embeds: EmbedBuilder[];
      allowedMentions: { parse: []; roles?: string[] };
    } = {
      embeds: [buildParentTicketEmbed(row, data)],
      allowedMentions: { parse: [] },
    };
    if (adminRoleId) {
      noticePayload.content = `<@&${adminRoleId}>`;
      noticePayload.allowedMentions = { roles: [adminRoleId], parse: [] };
    }
    await parent.send(noticePayload).catch(() => undefined);
    if (adminRoleId) await forceAddRoleMembersToThread(guild, thread.id, adminRoleId);

    return { threadId: thread.id, summaryMessageId: summaryMessage.id };
  }

  if (parent.type === ChannelType.GuildForum) {
    const thread = await parent.threads
      .create({
        name: tname,
        autoArchiveDuration: 1440,
        reason: "modmail ticket",
        message: summaryPayload,
      })
      .catch(() => null);
    if (!thread?.isTextBased()) return null;
    const starter = await thread.fetchStarterMessage().catch(() => null);
    if (!starter) return null;
    if (adminRoleId) {
      await thread
        .send({
          content: `<@&${adminRoleId}>`,
          allowedMentions: { roles: [adminRoleId], parse: [] },
        })
        .catch(() => undefined);
      await forceAddRoleMembersToThread(guild, thread.id, adminRoleId);
    }
    return { threadId: thread.id, summaryMessageId: starter.id };
  }

  return null;
}

export async function relayUserDmToThread(
  ctx: BotContext,
  row: ModmailThreadRow,
  dmMessage: Message,
  isFirst: boolean,
): Promise<void> {
  if (!row.thread_id) return;
  const guild = await ctx.client.guilds.fetch(row.guild_id).catch(() => null);
  if (!guild) return;
  const thread = await guild.channels.fetch(row.thread_id).catch(() => null);
  if (!thread || !thread.isTextBased()) return;
  const relayCh = thread as RelayChannel;

  const attach = serializeAttachments(dmMessage);
  const header = [
    "User DM 受信",
    `送信日時: ${formatDiscordTime(new Date(dmMessage.createdTimestamp).toISOString())}`,
    isFirst ? "このメッセージでチケットが作成されました。" : null,
    "本文:",
    dmMessage.content?.trim() || "(本文なし)",
  ]
    .filter(Boolean)
    .join("\n");

  await sendLong(relayCh, header).catch((e) => {
    ctx.log.warn({ err: e, modmailId: row.id }, "modmail dm relay failed");
  });

  if (attach.length > 0) {
    const lines = ["添付:", ...attach.map((a) => `- ${a.name ?? "?"} | ${a.size ?? 0} bytes | ${a.url ?? "-"}`)];
    await sendLong(relayCh, lines.join("\n")).catch(() => undefined);
  }

  void logModmailEvent(ctx, "USER_DM_RECEIVED", {
    ticket_id: row.id,
    guild_id: row.guild_id,
    user_id: row.user_id,
    thread_id: row.thread_id,
    source_message_id: dmMessage.id,
    is_first: isFirst,
  });
}

export async function relayUserPayloadToThread(
  ctx: BotContext,
  row: ModmailThreadRow,
  kind: "User Reply" | "User Reply Attachment" | "User DM 受信",
  body: string,
  attach: AttachmentMeta[],
  opts?: { isFirstTicketMessage?: boolean },
): Promise<void> {
  if (!row.thread_id) return;
  const guild = await ctx.client.guilds.fetch(row.guild_id).catch(() => null);
  if (!guild) return;
  const thread = await guild.channels.fetch(row.thread_id).catch(() => null);
  if (!thread || !thread.isTextBased()) return;
  const relayCh = thread as RelayChannel;
  const prefix = opts?.isFirstTicketMessage ? "このメッセージでチケットが作成されました。\n\n" : "";
  const cleaned = trimMax(prefix + (body.trim() || "(本文なし)"), 4000);
  const embed = new EmbedBuilder()
    .setTitle(kind)
    .setDescription(cleaned)
    .setColor(0x3498db)
    .setTimestamp(new Date());
  try {
    await relayCh.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (e) {
    ctx.log.warn({ err: e, modmailId: row.id }, "relayUserPayloadToThread failed");
    return;
  }
  if (attach.length > 0) {
    const fwd = await buildForwardDmFiles(attachmentMetaToJson(attach));
    if (fwd.files.length > 0) {
      await relayCh.send({ files: fwd.files, allowedMentions: { parse: [] } }).catch(() => undefined);
    }
    if (fwd.failed.length > 0) {
      const lines = ["添付の一部転送に失敗しました。", ...fwd.failed.slice(0, 8).map((u) => `- ${u}`)];
      await sendLong(relayCh, lines.join("\n")).catch(() => undefined);
    }
  }
  void logModmailEvent(ctx, "USER_REPLY_RELAY", { ticket_id: row.id, guild_id: row.guild_id, kind });
}

async function relayModalIntakeToThread(
  ctx: BotContext,
  row: ModmailThreadRow,
  title: string,
  body: string,
  attach: AttachmentMeta[],
): Promise<void> {
  if (!row.thread_id) return;
  const guild = await ctx.client.guilds.fetch(row.guild_id).catch(() => null);
  if (!guild) return;
  const thread = await guild.channels.fetch(row.thread_id).catch(() => null);
  if (!thread || !thread.isTextBased()) return;
  const relayCh = thread as RelayChannel;

  const header = [
    "フォーム受付",
    `送信日時: ${formatDiscordTime(new Date().toISOString())}`,
    "この送信でチケットが作成されました。",
    `タイトル: ${title || "(未設定)"}`,
    "相談内容:",
    body.trim() || "(本文なし)",
  ].join("\n");

  await sendLong(relayCh, header).catch((e) => {
    ctx.log.warn({ err: e, modmailId: row.id }, "relayModalIntakeToThread text failed");
  });

  if (attach.length > 0) {
    const lines = ["添付ファイル:", ...attach.map((a) => `- ${a.name ?? "?"} | ${a.size ?? 0} bytes | ${a.url ?? "-"}`)];
    await sendLong(relayCh, lines.join("\n")).catch(() => undefined);
    const fwd = await buildForwardDmFiles(attachmentMetaToJson(attach));
    if (fwd.files.length > 0) {
      await relayCh.send({ files: fwd.files, allowedMentions: { parse: [] } }).catch(() => undefined);
    }
    if (fwd.failed.length > 0) {
      const failLines = ["添付の一部転送に失敗しました。", ...fwd.failed.slice(0, 8).map((u) => `- ${u}`)];
      await sendLong(relayCh, failLines.join("\n")).catch(() => undefined);
    }
  }

  void logModmailEvent(ctx, "USER_DM_RECEIVED", {
    ticket_id: row.id,
    guild_id: row.guild_id,
    user_id: row.user_id,
    thread_id: row.thread_id,
    source: "modal_intake",
  });
}

export type CreateTicketFromIntakeFormResult = { ok: boolean; message: string };

// DiscordBOTv2 `ModmailCog.createTicketFromIntakeForm` 相当

export async function createTicketFromIntakeForm(
  ctx: BotContext,
  params: {
    guildId: string;
    userId: string;
    title: string;
    body: string;
    attachments: AttachmentMeta[];
  },
): Promise<CreateTicketFromIntakeFormResult> {
  const gid = params.guildId.trim();
  const uid = params.userId.trim();
  const normalizedTitle = trimMax(params.title.trim(), 120);
  const normalizedBody = trimMax(params.body.trim(), 1000);
  const normalizedAttachments = params.attachments.slice(0, 8);

  if (!gid || !uid || !normalizedTitle || !normalizedBody) {
    return { ok: false, message: "タイトルと相談内容を入力してください。" };
  }

  const open = await openModmailByGuildUser(ctx, gid, uid);
  if (open) {
    return { ok: false, message: "現在対応中のチケットがあります。新規作成はできません。" };
  }

  const hasIntake = await activeIntakeByGuildUser(ctx, gid, uid);
  if (!hasIntake) {
    return { ok: false, message: "サーバー内の「Modmailを始める」から相談を開始してください。" };
  }

  const guild = await ctx.client.guilds.fetch(gid).catch(() => null);
  if (!guild) {
    void logModmailEvent(ctx, "ERROR", {
      guild_id: gid,
      user_id: uid,
      content: normalizedBody,
      failure_reason: "guild_not_found_for_modal_intake",
    });
    return { ok: false, message: "サーバー情報の取得に失敗しました。時間をおいて再度お試しください。" };
  }

  let mmId: string;
  try {
    mmId = await createModmailSkeleton(ctx, gid, uid, normalizedBody, normalizedTitle, null, "modal_intake");
  } catch {
    return { ok: false, message: "チケット作成に失敗しました。時間をおいて再度お試しください。" };
  }

  const row = await fetchModmailRow(ctx, mmId);
  if (!row) {
    await deleteModmailById(ctx, mmId);
    return { ok: false, message: "チケット作成に失敗しました。時間をおいて再度お試しください。" };
  }

  const created = await createStaffThread(ctx, guild, row).catch(() => null);
  if (!created) {
    await deleteModmailById(ctx, mmId);
    void logModmailEvent(ctx, "ERROR", {
      ticket_id: mmId,
      guild_id: gid,
      user_id: uid,
      content: normalizedBody,
      failure_reason: "create_staff_thread_failed",
    });
    return { ok: false, message: "チケット作成に失敗しました。時間をおいて再度お試しください。" };
  }

  const parentId = resolveModmailParentChannelId(ctx.config);
  if (!parentId) {
    await deleteModmailById(ctx, mmId);
    return { ok: false, message: "チケット作成に失敗しました。時間をおいて再度お試しください。" };
  }

  await updateModmailThreadMeta(ctx, mmId, parentId, created.threadId, {
    panel_message_id: created.summaryMessageId,
    info_message_id: created.summaryMessageId,
    body: normalizedBody,
    subject: normalizedTitle,
  });

  const full = await fetchModmailRow(ctx, mmId);
  if (!full) {
    await deleteModmailById(ctx, mmId);
    return { ok: false, message: "チケット作成に失敗しました。時間をおいて再度お試しください。" };
  }

  await consumeModmailIntake(ctx, gid, uid);
  await relayModalIntakeToThread(ctx, full, normalizedTitle, normalizedBody, normalizedAttachments).catch(() => undefined);

  void logModmailEvent(ctx, "TICKET_CREATED", {
    ticket_id: full.id,
    guild_id: full.guild_id,
    user_id: full.user_id,
    thread_id: full.thread_id,
    status: full.status,
    content: normalizedBody,
    extra_json: {
      source: "modal",
      title: normalizedTitle,
      attachment_count: normalizedAttachments.length,
    },
  });

  return {
    ok: true,
    message: `チケットを作成しました。受付番号: ${ticketDisplayCode(full.id)}`,
  };
}

export async function createFromFirstDm(
  ctx: BotContext,
  intakeGuildId: string,
  dmMessage: Message,
): Promise<ModmailThreadRow | null> {
  const uid = dmMessage.author.id;
  const guild = await ctx.client.guilds.fetch(intakeGuildId).catch(() => null);
  if (!guild) return null;

  const existing = await openModmailByGuildUser(ctx, intakeGuildId, uid);
  if (existing) {
    await consumeModmailIntake(ctx, intakeGuildId, uid);
    await relayUserDmToThread(ctx, existing, dmMessage, false);
    return existing;
  }

  const body = trimMax(dmMessage.content?.trim() ?? "", 1000) || "(本文なし)";
  let mmId: string;
  try {
    mmId = await createModmailSkeleton(ctx, intakeGuildId, uid, body, null, dmMessage.id, "dm_first");
  } catch {
    return null;
  }

  const row = await fetchModmailRow(ctx, mmId);
  if (!row) return null;

  const created = await createStaffThread(ctx, guild, row).catch(() => null);
  if (!created) {
    await deleteModmailById(ctx, mmId);
    return null;
  }

  const parentId = resolveModmailParentChannelId(ctx.config);
  if (!parentId) {
    await deleteModmailById(ctx, mmId);
    return null;
  }

  await updateModmailThreadMeta(ctx, mmId, parentId, created.threadId, {
    panel_message_id: created.summaryMessageId,
    info_message_id: created.summaryMessageId,
    body,
  });

  const full = await fetchModmailRow(ctx, mmId);
  if (!full) return null;
  await consumeModmailIntake(ctx, intakeGuildId, uid);
  await relayUserDmToThread(ctx, full, dmMessage, true);
  return full;
}

// 添付モーダル経由の初回作成（本文 + メタ添付）

export async function createFromFirstDmWithAttachments(
  ctx: BotContext,
  intakeGuildId: string,
  userId: string,
  body: string,
  attach: AttachmentMeta[],
): Promise<ModmailThreadRow | null> {
  const guild = await ctx.client.guilds.fetch(intakeGuildId).catch(() => null);
  if (!guild) return null;

  const existing = await openModmailByGuildUser(ctx, intakeGuildId, userId);
  if (existing) {
    await consumeModmailIntake(ctx, intakeGuildId, userId);
    await relayUserPayloadToThread(ctx, existing, "User DM 受信", body, attach);
    return existing;
  }

  const b = trimMax(body, 1000) || "(本文なし)";
  let mmId: string;
  try {
    mmId = await createModmailSkeleton(ctx, intakeGuildId, userId, b, null, null, "dm_first_attach");
  } catch {
    return null;
  }

  const row = await fetchModmailRow(ctx, mmId);
  if (!row) return null;

  const created = await createStaffThread(ctx, guild, row).catch(() => null);
  if (!created) {
    await deleteModmailById(ctx, mmId);
    return null;
  }

  const parentId = resolveModmailParentChannelId(ctx.config);
  if (!parentId) {
    await deleteModmailById(ctx, mmId);
    return null;
  }

  await updateModmailThreadMeta(ctx, mmId, parentId, created.threadId, {
    panel_message_id: created.summaryMessageId,
    info_message_id: created.summaryMessageId,
    body: b,
  });

  const full = await fetchModmailRow(ctx, mmId);
  if (!full) return null;
  await consumeModmailIntake(ctx, intakeGuildId, userId);
  await relayUserPayloadToThread(ctx, full, "User DM 受信", b, attach, { isFirstTicketMessage: true });
  return full;
}

export async function handleModmailDmMessage(ctx: BotContext, message: Message): Promise<boolean> {
  if (message.author.bot) return false;
  const hasBody = Boolean(message.content?.trim());
  const hasAttach = message.attachments.size > 0;
  if (!hasBody && !hasAttach) return false;

  const open = await anyOpenModmailByUser(ctx, message.author.id);
  if (open) {
    await relayUserDmToThread(ctx, open, message, false);
    return true;
  }

  const intake = await activeIntakeByUser(ctx, message.author.id);
  if (!intake) {
    await message.author
      .send({
        embeds: [
          new EmbedBuilder()
            .setTitle("Modmail のご案内")
            .setDescription(
              "サーバー内の「Modmailを始める」から DM 案内を受け取り、「チケットを作成」またはメッセージ送信で相談を開始してください。",
            )
            .setColor(0xe67e22)
            .setTimestamp(new Date()),
        ],
      })
      .catch(() => undefined);
    return true;
  }

  const created = await createFromFirstDm(ctx, intake.guild_id, message);
  if (!created) {
    await message.author
      .send({
        embeds: [
          new EmbedBuilder()
            .setTitle("送信失敗")
            .setDescription("チケットの作成に失敗しました。サーバーで受付からやり直してください。")
            .setColor(0xe74c3c)
            .setTimestamp(new Date()),
        ],
      })
      .catch(() => undefined);
  }
  return true;
}

export async function sendModmailStartDm(user: User, rows: unknown[]): Promise<void> {
  await user.send({
    embeds: [
      new EmbedBuilder()
        .setTitle("Modmail 受付")
        .setDescription(
          [
            "Modmail 受付です。",
            "下の「チケットを作成」ボタンからタイトル・詳細・任意の添付を入力すると、スタッフ側にチケットが作成されます。",
            "テキストのみ先に送りたい場合は、この DM にメッセージを送っても構いません（最初のメッセージで受付が始まります）。",
          ].join("\n"),
        )
        .setColor(0x3498db)
        .setTimestamp(new Date()),
    ],
    components: rows as never,
  });
}

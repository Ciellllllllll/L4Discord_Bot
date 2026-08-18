import { ComponentCardBuilder, componentCardsPayload } from "../panels/componentCard.js";
import {
  ActionRowBuilder,
  AuditLogEvent,
  ButtonBuilder,
  ButtonStyle,
  type Channel,
  type Guild,
  type GuildAuditLogsEntry,
  type GuildBan,
  type GuildMember,
  type Message,
  type PartialGuildMember,
  type TextChannel,
} from "discord.js";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { BotContext } from "../../bot/context.js";
import { sqliteTimestamp } from "../../core/db/sqliteTimestamp.js";
import { getGuildSettingsData } from "../../core/guildSettings.js";
import { createPendingAppealStartContext } from "../appeals/appealPending.js";
import { buildAppealStartRows } from "../appeals/appealUi.js";
import { resolveModLogChannelId } from "./modLog.js";

export const DETECTER_REASON_INPUT_ID = "detecter_reason_text";

type PunishmentType = "ban" | "kick" | "timeout";

export type PunishmentEvent = {
  eventId: string;
  punishmentType: PunishmentType;
  guildId: string;
  guildName: string;
  targetUserId: string;
  targetDisplay: string;
  actorUserId: string;
  actorDisplay: string;
  detectedReason: string;
  timeoutStart: number;
  timeoutEnd: number;
  promptChannelId: string;
  promptMessageId: string;
  reasonButtonFired: boolean;
  createdAt: Date;
  auditId: string;
};

function normalizeSnowflake(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return "";
  return text;
}

function utcNow(): Date {
  return new Date();
}

function safeText(value: unknown, fallback = "-"): string {
  const text = value === null || value === undefined ? "" : String(value).trim();
  return text || fallback;
}

function userDisplayName(
  u: { username?: string | null; globalName?: string | null } | null | undefined,
): string {
  const name = u?.username;
  if (name == null || name === "") return "不明";
  return safeText(u!.globalName ?? name, "不明");
}

function formatPunishmentType(punishmentType: string): string {
  if (punishmentType === "timeout") return "タイムアウト";
  if (punishmentType === "kick") return "キック";
  if (punishmentType === "ban") return "BAN";
  return safeText(punishmentType, "不明");
}

function fmtDt(dt: Date | null | undefined): string {
  if (!dt) return "-";
  return `<t:${Math.floor(dt.getTime() / 1000)}:F>`;
}

function extractPublicExecutionApprover(reasonText: string): string {
  const m = /approved_by=(\d+)/.exec(reasonText || "");
  if (!m) return "";
  return normalizeSnowflake(m[1] ?? "");
}

// DiscordBOTv2 Detecter.js の timeoutUntil と同じ（gateway の before/after をそのまま評価）

function timeoutUntil(member: GuildMember | PartialGuildMember): Date | null {
  const until = member.communicationDisabledUntil;
  if (!until) return null;
  return new Date(until);
}

export type AuditLookupResult = {
  actorId: string;
  actorDisplay: string;
  reason: string;
  /** 監査ログの reason が空でなく、モデレーターが入力したとみなせる場合 */
  hasExplicitAuditReason: boolean;
  auditId: string;
  createdAt: Date;
    // MemberUpdate 監査の communication_disabled_until 新値（ゲートウェイで member が欠ける場合の補完用）

  communicationDisabledUntilFromAudit: Date | null;
};

let serviceInstance: DetecterService | undefined;

export function getDetecterService(ctx: BotContext): DetecterService {
  if (!serviceInstance) serviceInstance = new DetecterService(ctx);
  return serviceInstance;
}

export class DetecterService {
  private readonly pendingEvents = new Map<string, PunishmentEvent>();
  private readonly processedAuditIds = new Map<string, number>();
  private readonly recentKeys = new Map<string, number>();

  constructor(private readonly ctx: BotContext) {
    setInterval(() => this.cleanupMemory(), 30 * 1000);
  }

  getPendingEvent(eventId: string): PunishmentEvent | undefined {
    return this.pendingEvents.get(eventId);
  }

  private cleanupMemory(): void {
    const now = utcNow().getTime();
    const cfg = this.ctx.config;

    const auditCutoff = now - 2 * 60 * 60 * 1000;
    for (const [key, ts] of this.processedAuditIds.entries()) {
      if (ts < auditCutoff) this.processedAuditIds.delete(key);
    }

    const dedupeCutoff = now - 10 * 60 * 1000;
    for (const [key, ts] of this.recentKeys.entries()) {
      if (ts < dedupeCutoff) this.recentKeys.delete(key);
    }

    const eventCutoff = now - cfg.DETECTER_PROMPT_TIMEOUT_SEC * 1000;
    for (const [key, ev] of this.pendingEvents.entries()) {
      if (ev.createdAt.getTime() < eventCutoff) this.pendingEvents.delete(key);
    }
  }

  private makeRecentKey(input: {
    guildId: string;
    userId: string;
    punishmentType: string;
    timeoutEnd: number;
  }): string {
    const bucket = Math.floor(Date.now() / 1000 / 15);
    return `${input.guildId}:${input.userId}:${input.punishmentType}:${input.timeoutEnd}:${bucket}`;
  }

  private isRecentDuplicate(key: string): boolean {
    const now = Date.now();
    const prev = this.recentKeys.get(key);
    this.recentKeys.set(key, now);
    if (!prev) return false;
    const dup = now - prev < 15 * 1000;
    return dup;
  }

  private entryHasTimeoutChange(entry: GuildAuditLogsEntry): boolean {
    try {
      const changes = entry.changes ?? [];
      for (const change of changes) {
        const key = String(change.key ?? "");
        if (["communication_disabled_until", "timed_out_until", "timeout_until"].includes(key)) return true;
      }
    } catch {
      return false;
    }
    return false;
  }

    // Discord 監査のタイムアウト終了値（型ゆらぎ対応）。秒/ミリ秒の数値も許容

  private parseAuditTimeoutRaw(raw: unknown): Date | null {
    if (raw == null || raw === "") return null;
    if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      const ms = raw < 1_000_000_000_000 ? raw * 1000 : raw;
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    if (typeof raw === "bigint") {
      const n = Number(raw);
      const ms = n < 1_000_000_000_000 ? n * 1000 : n;
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    if (typeof raw === "object" && raw !== null && "value" in raw) {
      return this.parseAuditTimeoutRaw((raw as { value: unknown }).value);
    }
    const s = String(raw).trim();
    if (!s) return null;
    const parsed = Date.parse(s);
    if (!Number.isNaN(parsed)) return new Date(parsed);
    const num = Number(s);
    if (Number.isFinite(num)) {
      const ms = num < 1_000_000_000_000 ? num * 1000 : num;
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    return null;
  }

    // 監査ログ changes の新タイムアウト終了時刻。
  // 同一エントリに複数の timeout 系 change があり、先頭の new が null だけの場合があるため、
  // 該当キーをすべて走査し new から取れた最も遅い有効日時を採用する。

  private parseCommunicationDisabledUntilFromEntry(entry: GuildAuditLogsEntry): Date | null {
    try {
      let best: Date | null = null;
      for (const c of entry.changes ?? []) {
        const key = String(c.key ?? "");
        if (!["communication_disabled_until", "timed_out_until", "timeout_until"].includes(key)) continue;
        const d = this.parseAuditTimeoutRaw(c.new);
        if (d && (!best || d.getTime() > best.getTime())) best = d;
      }
      return best;
    } catch {
      return null;
    }
  }

  private async findAuditLogForTarget(input: {
    guild: Guild;
    action: AuditLogEvent;
    targetUserId: string;
    requireTimeoutChange?: boolean;
  }): Promise<AuditLookupResult | null> {
    const normalizedTargetId = normalizeSnowflake(input.targetUserId);
    if (!normalizedTargetId) {
      return null;
    }

    const me = input.guild.members.me;
    if (!me?.permissions.has("ViewAuditLog")) {
      return null;
    }

    const cfg = this.ctx.config;
    const retries = [250, 800, 1500];
    for (const wait of retries) {
      if (wait > 0) {
        await delay(wait);
      }
      try {
        const audits = await input.guild.fetchAuditLogs({ limit: 50, type: input.action });
        const entries = [...audits.entries.values()];
        for (const entry of entries) {
          const entryTargetId = normalizeSnowflake(entry.target && "id" in entry.target ? entry.target.id : "");
          if (entryTargetId !== normalizedTargetId) continue;
          const auditId = normalizeSnowflake(entry.id);
          if (!auditId) continue;
          if (this.processedAuditIds.has(auditId)) {
            continue;
          }

          const createdAt = entry.createdAt;
          const ageSec = (Date.now() - createdAt.getTime()) / 1000;
          if (ageSec > cfg.DETECTER_AUDIT_WINDOW_SEC) {
            continue;
          }

          if (input.requireTimeoutChange && !this.entryHasTimeoutChange(entry)) {
            continue;
          }

          const actor = entry.executor;
          const communicationDisabledUntilFromAudit = this.entryHasTimeoutChange(entry)
            ? this.parseCommunicationDisabledUntilFromEntry(entry)
            : null;
          if (input.requireTimeoutChange) {
            const now = utcNow();
            if (!communicationDisabledUntilFromAudit) {
              continue;
            }
            if (communicationDisabledUntilFromAudit.getTime() <= now.getTime()) {
              continue;
            }
          }

          const rawReason = entry.reason;
          const hasExplicitAuditReason = rawReason != null && String(rawReason).trim() !== "";

          return {
            actorId: normalizeSnowflake(actor?.id ?? ""),
            actorDisplay: userDisplayName(actor),
            reason: safeText(entry.reason, cfg.DETECTER_DEFAULT_REASON_TEXT),
            hasExplicitAuditReason,
            auditId,
            createdAt,
            communicationDisabledUntilFromAudit,
          };
        }
      } catch (err) {
        this.ctx.log.warn({ err }, "detecter: failed to inspect audit log");
        return null;
      }
    }
    return null;
  }

  private async resolveUser(userId: string): Promise<import("discord.js").User | null> {
    const id = normalizeSnowflake(userId);
    if (!id) return null;
    return this.ctx.client.users.cache.get(id) ?? this.ctx.client.users.fetch(id).catch(() => null);
  }

  private async resolveActorForPrompt(input: {
    guild: Guild;
    actorId: string;
    auditReason: string;
  }): Promise<{ actorId: string; actorDisplay: string; strictActor: boolean }> {
    if (input.actorId) {
      const actor = await this.resolveUser(input.actorId);
      if (actor && !actor.bot) {
        return {
          actorId: input.actorId,
          actorDisplay: userDisplayName(actor),
          strictActor: true,
        };
      }
    }

    const approvedById = extractPublicExecutionApprover(input.auditReason);
    if (approvedById) {
      const user = await this.resolveUser(approvedById);
      if (user) {
        return {
          actorId: approvedById,
          actorDisplay: userDisplayName(user),
          strictActor: true,
        };
      }
    }

    if (input.guild.ownerId) {
      const owner = await this.resolveUser(input.guild.ownerId);
      if (owner) {
        return {
          actorId: owner.id,
          actorDisplay: userDisplayName(owner),
          strictActor: false,
        };
      }
    }

    const ownerEnv = normalizeSnowflake(this.ctx.config.OWNER_ID);
    if (ownerEnv) {
      const owner = await this.resolveUser(ownerEnv);
      if (owner) {
        return {
          actorId: owner.id,
          actorDisplay: userDisplayName(owner),
          strictActor: false,
        };
      }
    }

    return { actorId: "", actorDisplay: "不明", strictActor: false };
  }

  private resolveReasonPromptChannelId(): string {
    return resolveModLogChannelId(this.ctx.config);
  }

  private async resolveLoggerChannel(guild: Guild): Promise<TextChannel | null> {
    const chId = this.resolveReasonPromptChannelId();
    if (!chId) return null;

    let channel: Channel | undefined = guild.channels.cache.get(chId);
    if (!channel) {
      channel = (await this.ctx.client.channels.fetch(chId).catch(() => null)) ?? undefined;
    }
    if (!channel?.isTextBased()) return null;
    if ("guildId" in channel && String(channel.guildId) !== String(guild.id)) return null;
    return channel as TextChannel;
  }

  private buildReasonPromptEmbed(event: PunishmentEvent, reasonText: string): ComponentCardBuilder {
    const cfg = this.ctx.config;
    const embed = new ComponentCardBuilder()
      .setTitle("処罰理由の入力が必要です")
      .setDescription("下のボタンからモーダルを開き、処罰理由を入力してください。")
      .setTimestamp(new Date())
      .addFields(
        { name: "実行者", value: `${event.actorDisplay} (\`${event.actorUserId}\`)`, inline: false },
        { name: "サーバー", value: `${event.guildName} (${event.guildId})`, inline: false },
        { name: "対象ユーザー", value: `${event.targetDisplay} (\`${event.targetUserId}\`)`, inline: false },
        { name: "処罰種別", value: formatPunishmentType(event.punishmentType), inline: false },
        { name: "監査ログ上の理由", value: safeText(reasonText, cfg.DETECTER_DEFAULT_REASON_TEXT), inline: false },
        { name: "状態", value: buildDetecterStatusDisplayText(event, cfg).slice(0, 1024), inline: false },
      )
      .setFooter({ text: `event_id=${event.eventId}` });

    if (event.punishmentType === "timeout") {
      embed.addFields({
        name: "タイムアウト終了日時",
        value: fmtDt(new Date(event.timeoutEnd * 1000)),
        inline: false,
      });
    }
    return embed;
  }

  private async finalizeReasonPrompt(event: PunishmentEvent, reasonText: string): Promise<void> {
    if (!event.promptChannelId || !event.promptMessageId) return;

    let channel: Channel | undefined = this.ctx.client.channels.cache.get(event.promptChannelId);
    if (!channel) {
      channel = (await this.ctx.client.channels.fetch(event.promptChannelId).catch(() => null)) ?? undefined;
    }
    if (!channel?.isTextBased()) return;

    const message = (await (channel as TextChannel).messages
      .fetch(event.promptMessageId)
      .catch(() => null)) as Message | null;
    if (!message) return;

    const updatedEmbed = this.buildReasonPromptEmbed(event, reasonText);
    await message.edit(componentCardsPayload([updatedEmbed])).catch(() => undefined);
  }

  /** 監査ログに理由がある場合：ボタンなし・メンションは通知なし。対象者 DM は insertIncidentAndDmTarget 側。 */
  private async sendAuditReasonLoggedNotice(event: PunishmentEvent): Promise<boolean> {
    const guild = this.ctx.client.guilds.cache.get(event.guildId);
    if (!guild) return false;

    const promptChannel = await this.resolveLoggerChannel(guild);
    if (!promptChannel) {
      this.ctx.log.warn(
        { guildId: event.guildId, channelId: this.resolveReasonPromptChannelId() },
        "detecter: mod log / logger channel not found (audit reason path)",
      );
      return false;
    }

    const embed = new ComponentCardBuilder()
      .setTitle("処罰の記録（監査ログに理由あり）")
      .setDescription("監査ログに理由が入力されているため、理由入力ボタンは表示していません。対象ユーザーへ異議申し立て案内を送信しました。")
      .setTimestamp(new Date())
      .addFields(
        { name: "実行者", value: `${event.actorDisplay} (\`${event.actorUserId}\`)`, inline: false },
        { name: "サーバー", value: `${event.guildName} (${event.guildId})`, inline: false },
        { name: "対象ユーザー", value: `${event.targetDisplay} (\`${event.targetUserId}\`)`, inline: false },
        { name: "処罰種別", value: formatPunishmentType(event.punishmentType), inline: false },
        { name: "監査ログ上の理由", value: safeText(event.detectedReason, this.ctx.config.DETECTER_DEFAULT_REASON_TEXT), inline: false },
        {
          name: "状態",
          value: buildDetecterStatusDisplayText(event, this.ctx.config).slice(0, 1024),
          inline: false,
        },
      )
      .setFooter({ text: `event_id=${event.eventId}` });

    if (event.punishmentType === "timeout") {
      embed.addFields({
        name: "タイムアウト終了日時",
        value: fmtDt(new Date(event.timeoutEnd * 1000)),
        inline: false,
      });
    }

    const notice = `<@${event.actorUserId}>さん。<@${event.targetUserId}> への処罰について、監査ログに理由が記録されています。`;
    embed.setDescription(`${notice}\n\n${embed.data.description ?? ""}`);

    try {
      await promptChannel.send({
        ...componentCardsPayload([embed]),
        allowedMentions: { parse: [] },
      });
      return true;
    } catch (err) {
      this.ctx.log.warn({ err }, "detecter: failed to send audit-reason notice");
      return false;
    }
  }

  private async sendReasonPrompt(event: PunishmentEvent): Promise<boolean> {
    const guild = this.ctx.client.guilds.cache.get(event.guildId);
    if (!guild) return false;

    const promptChannel = await this.resolveLoggerChannel(guild);
    if (!promptChannel) {
      this.ctx.log.warn(
        { guildId: event.guildId, channelId: this.resolveReasonPromptChannelId() },
        "detecter: mod log / logger channel not found or inaccessible",
      );
      return false;
    }

    const embed = this.buildReasonPromptEmbed(event, event.detectedReason);
    const button = new ButtonBuilder()
      .setCustomId(`detecter:reasonPrompt:${event.eventId}`)
      .setLabel("理由を入力")
      .setStyle(ButtonStyle.Primary);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);
    const notice = `<@${event.actorUserId}>さん。<@${event.targetUserId}> への処罰理由を入力してください。`;
    embed.setDescription(`${notice}\n\n${embed.data.description ?? ""}`);

    try {
      const sent = await promptChannel.send({
        ...componentCardsPayload([embed], [row]),
        allowedMentions: { users: [event.actorUserId, event.targetUserId], roles: [], parse: [] },
      });
      event.promptChannelId = String(sent.channelId ?? promptChannel.id);
      event.promptMessageId = String(sent.id);
      return true;
    } catch (err) {
      this.ctx.log.warn({ err }, "detecter: failed to send reason prompt");
      return false;
    }
  }

  private async insertIncidentAndDmTarget(
    event: PunishmentEvent,
    finalReason: string,
  ): Promise<boolean> {
    const target = await this.resolveUser(event.targetUserId);
    if (!target) {
      this.ctx.log.warn({ targetId: event.targetUserId }, "detecter: target user not found");
      return false;
    }

    const cfg = this.ctx.config;
    const auditKey = event.auditId || `synthetic:${event.eventId}`;
    const reason = safeText(finalReason, cfg.DETECTER_DEFAULT_REASON_TEXT);

    let row: { id: string } | undefined;
    try {
      row = await this.ctx.db
        .insertInto("detecter_incidents")
        .values({
          id: randomUUID(),
          guild_id: event.guildId,
          audit_entry_id: auditKey,
          executor_id: event.actorUserId || normalizeSnowflake(cfg.OWNER_ID) || "unknown",
          target_id: event.targetUserId,
          action_type: event.punishmentType,
          reason,
          appeal_ticket_id: null,
          created_at: sqliteTimestamp() as unknown as Date,
        })
        .returning("id")
        .executeTakeFirst();
    } catch (err) {
      this.ctx.log.warn({ err, auditKey }, "detecter: insert incident failed");
    }

    const appealUrl = (await getGuildSettingsData(this.ctx.db, event.guildId)).appeal_instructions_url;
    const embed = new ComponentCardBuilder()
      .setTitle("処罰通知")
      .setDescription("下のボタンから異議申し立てを送信できます。")
      .setTimestamp(new Date())
      .addFields(
        { name: "サーバー", value: `${event.guildName} (${event.guildId})`, inline: false },
        { name: "処罰種別", value: formatPunishmentType(event.punishmentType), inline: false },
        { name: "理由", value: safeText(reason, cfg.DETECTER_DEFAULT_REASON_TEXT), inline: false },
      );

    if (appealUrl) {
      embed.addFields({ name: "案内", value: appealUrl.slice(0, 1000), inline: false });
    }

    if (event.punishmentType === "timeout") {
      embed.addFields({
        name: "タイムアウト終了日時",
        value: fmtDt(new Date(event.timeoutEnd * 1000)),
        inline: false,
      });
    } else {
      embed.addFields({
        name: "異議申し立て期限",
        value: fmtDt(new Date(event.timeoutEnd * 1000)),
        inline: false,
      });
    }

    const appealCtxId = createPendingAppealStartContext({
      guildId: event.guildId,
      userId: event.targetUserId,
      timeoutStart: event.timeoutStart,
      timeoutEnd: event.timeoutEnd,
      punishmentType: event.punishmentType,
      punishmentReason: reason,
      detecterIncidentId: row?.id ?? null,
    });
    const appealComponents = buildAppealStartRows(appealCtxId);

    try {
      await target.send({
        ...componentCardsPayload([embed], appealComponents),
      });
      return true;
    } catch (err) {
      this.ctx.log.warn({ err, targetId: event.targetUserId }, "detecter: target DM failed");
      return false;
    }
  }

  async submitModeratorReason(
    moderatorUserId: string,
    eventId: string,
    moderatorReason: string,
  ): Promise<{ message: string }> {
    const event = this.pendingEvents.get(eventId);
    if (!event) {
      return { message: "このイベントは期限切れか、既に処理済みです。" };
    }
    if (moderatorUserId !== event.actorUserId) {
      return { message: "処罰を実行したユーザーのみ理由を送信できます。" };
    }
    if (event.reasonButtonFired) {
      return { message: "この理由入力は既に処理済みです。" };
    }

    event.reasonButtonFired = true;
    const reasonText = safeText(moderatorReason, event.detectedReason);
    const ok = await this.insertIncidentAndDmTarget(event, reasonText);
    await this.finalizeReasonPrompt(event, reasonText);
    this.pendingEvents.delete(eventId);

    return {
      message: ok ? "対象ユーザーへ通知しました。" : "対象ユーザーへの通知に失敗しました。",
    };
  }

  private async registerPunishment(input: {
    guild: Guild;
    targetUser: import("discord.js").User;
    punishmentType: PunishmentType;
    timeoutEndDt: Date | null;
    auditResult: AuditLookupResult | null;
  }): Promise<void> {
    const { guild, targetUser, punishmentType, timeoutEndDt, auditResult } = input;
    const cfg = this.ctx.config;
    const now = utcNow();
    const timeoutStart = Math.floor(now.getTime() / 1000);

    const timeoutEndDate =
      timeoutEndDt ?? new Date(now.getTime() + cfg.DETECTER_DEFAULT_APPEAL_WINDOW_SEC * 1000);
    let timeoutEnd = Math.floor(timeoutEndDate.getTime() / 1000);
    if (timeoutEnd <= timeoutStart) timeoutEnd = timeoutStart + 60;

    const auditActorId = auditResult ? normalizeSnowflake(auditResult.actorId) : "";
    const auditReason = auditResult?.reason ?? cfg.DETECTER_DEFAULT_REASON_TEXT;
    const hasExplicitAuditReason = auditResult?.hasExplicitAuditReason ?? false;

    const actor = await this.resolveActorForPrompt({
      guild,
      actorId: auditActorId,
      auditReason,
    });

    const auditId = auditResult ? normalizeSnowflake(auditResult.auditId) : "";
    if (auditId) {
      this.processedAuditIds.set(auditId, Date.now());
    }

    const dedupeKey = this.makeRecentKey({
      guildId: guild.id,
      userId: targetUser.id,
      punishmentType,
      timeoutEnd,
    });
    if (this.isRecentDuplicate(dedupeKey)) return;

    const eventId = `${guild.id}:${targetUser.id}:${punishmentType}:${timeoutStart}:${timeoutEnd}`;
    const event: PunishmentEvent = {
      eventId,
      punishmentType,
      guildId: guild.id,
      guildName: safeText(guild.name, `guild-${guild.id}`),
      targetUserId: normalizeSnowflake(targetUser.id),
      targetDisplay: safeText(userDisplayName(targetUser), targetUser.id),
      actorUserId: normalizeSnowflake(actor.actorId),
      actorDisplay: actor.actorDisplay,
      detectedReason: safeText(auditReason, cfg.DETECTER_DEFAULT_REASON_TEXT),
      timeoutStart,
      timeoutEnd,
      promptChannelId: "",
      promptMessageId: "",
      reasonButtonFired: false,
      createdAt: now,
      auditId,
    };

    if (actor.actorId && actor.strictActor) {
      if (hasExplicitAuditReason) {
        await this.sendAuditReasonLoggedNotice(event);
        await this.insertIncidentAndDmTarget(event, event.detectedReason);
        return;
      }

      this.pendingEvents.set(eventId, event);
      const sent = await this.sendReasonPrompt(event);
      if (!sent) {
        this.pendingEvents.delete(eventId);
        await this.insertIncidentAndDmTarget(event, event.detectedReason);
      }
      return;
    }

    await this.insertIncidentAndDmTarget(event, event.detectedReason);
  }

  async onGuildBanAdd(ban: GuildBan): Promise<void> {
    try {
      if (ban.guild.id !== this.ctx.config.GUILD_ID) return;
      const audit = await this.findAuditLogForTarget({
        guild: ban.guild,
        action: AuditLogEvent.MemberBanAdd,
        targetUserId: ban.user.id,
      });
      await this.registerPunishment({
        guild: ban.guild,
        targetUser: ban.user,
        punishmentType: "ban",
        timeoutEndDt: null,
        auditResult: audit,
      });
    } catch (err) {
      this.ctx.log.error({ err }, "detecter: guildBanAdd");
    }
  }

  async onGuildMemberRemove(member: GuildMember | PartialGuildMember): Promise<void> {
    try {
      if (member.guild.id !== this.ctx.config.GUILD_ID) return;
      const m = member.partial ? await member.fetch().catch(() => null) : member;
      if (!m) return;
      const user = m.user;
      if (!user) return;

      const audit = await this.findAuditLogForTarget({
        guild: m.guild,
        action: AuditLogEvent.MemberKick,
        targetUserId: m.id,
      });
      if (!audit) return;

      await this.registerPunishment({
        guild: m.guild,
        targetUser: user,
        punishmentType: "kick",
        timeoutEndDt: null,
        auditResult: audit,
      });
    } catch (err) {
      this.ctx.log.error({ err }, "detecter: guildMemberRemove (kick)");
    }
  }

  async onGuildMemberUpdate(before: GuildMember | PartialGuildMember, after: GuildMember | PartialGuildMember): Promise<void> {
    try {
      if (after.guild.id !== this.ctx.config.GUILD_ID) return;

      // ゲートウェイの before/after を fetch で置き換えない。短縮・延長・初回適用を区別し、after に終了が載らないレースは監査で補う。
      const beforeUntil = timeoutUntil(before);
      const afterUntil = timeoutUntil(after);
      const now = utcNow();

      const afterHasActiveTimeout = Boolean(afterUntil && afterUntil > now);
      const communicationTimeoutEndChanged =
        !beforeUntil ||
        !afterUntil ||
        afterUntil.getTime() !== beforeUntil.getTime();

      const v2PrimaryOk = afterHasActiveTimeout && communicationTimeoutEndChanged;

      let audit = await this.findAuditLogForTarget({
        guild: after.guild,
        action: AuditLogEvent.MemberUpdate,
        targetUserId: after.id,
        requireTimeoutChange: true,
      });

      const auditEnd = audit?.communicationDisabledUntilFromAudit ?? null;
      let timeoutEndDt: Date | null = v2PrimaryOk ? afterUntil : null;
      if (
        !timeoutEndDt &&
        auditEnd &&
        auditEnd > now &&
        (!beforeUntil || auditEnd > beforeUntil || !afterUntil)
      ) {
        timeoutEndDt = auditEnd;
      }

      if (!timeoutEndDt) {
        return;
      }

      if (!audit) {
        audit = await this.findAuditLogForTarget({
          guild: after.guild,
          action: AuditLogEvent.MemberUpdate,
          targetUserId: after.id,
          requireTimeoutChange: false,
        });
      }

      let targetUser: import("discord.js").User | null = after.user ?? null;
      if (!targetUser) {
        const fetched = await after.fetch().catch(() => null);
        targetUser = fetched?.user ?? null;
      }
      if (!targetUser) {
        return;
      }

      await this.registerPunishment({
        guild: after.guild,
        targetUser,
        punishmentType: "timeout",
        timeoutEndDt,
        auditResult: audit,
      });
    } catch (err) {
      this.ctx.log.error({ err }, "detecter: guildMemberUpdate");
    }
  }
}

/** 理由プロンプト Embed の「状態」欄（開いた時点のスナップショット） */
export function buildDetecterStatusDisplayText(
  event: PunishmentEvent,
  cfg: { DETECTER_DEFAULT_REASON_TEXT: string },
): string {
  const r = safeText(event.detectedReason, cfg.DETECTER_DEFAULT_REASON_TEXT);
  const auditLine =
    r === cfg.DETECTER_DEFAULT_REASON_TEXT
      ? "未入力（下の「理由」欄に入力してください）"
      : `参照: ${r.slice(0, 500)}`;
  return ["審査待ち：モデレーターによる理由入力待ち", `監査ログの理由：${auditLine}`].join("\n");
}


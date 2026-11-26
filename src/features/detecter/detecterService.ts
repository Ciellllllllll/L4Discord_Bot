import { componentCardsPayload } from "../../core/componentCard.js";
import {
  ActionRowBuilder,
  AuditLogEvent,
  ButtonBuilder,
  ButtonStyle,
  type Channel,
  type Guild,
  type GuildBan,
  type GuildMember,
  type Message,
  type PartialGuildMember,
  type TextChannel,
  type User,
} from "discord.js";
import { randomUUID } from "node:crypto";
import type { BotContext } from "../../bot/context.js";
import { nowIso } from "../../core/db/nowIso.js";
import { getGuildSettingsData } from "../../core/guildSettings.js";
import { normalizeSnowflake } from "../../core/snowflake.js";
import { TtlStore } from "../../core/ttlStore.js";
import { createPendingAppealStartContext } from "../appeals/appealPending.js";
import { buildAppealStartRows } from "../appeals/appealUi.js";
import { resolveModLogChannelId } from "./modLog.js";
import {
  extractPublicExecutionApprover,
  findAuditLogForTarget,
  safeText,
  userDisplayName,
  type AuditLookupResult,
} from "./detecterAudit.js";
import {
  buildAuditReasonLoggedCard,
  buildDetecterStatusDisplayText,
  buildReasonPromptCard,
  buildTargetPunishmentDmCard,
  type PunishmentEvent,
  type PunishmentType,
} from "./detecterCards.js";

export const DETECTER_REASON_INPUT_ID = "detecter_reason_text";
export type { AuditLookupResult, PunishmentEvent };
export { buildDetecterStatusDisplayText };

function timeoutUntil(member: GuildMember | PartialGuildMember): Date | null {
  const until = member.communicationDisabledUntil;
  return until ? new Date(until) : null;
}

let serviceInstance: DetecterService | undefined;

export function getDetecterService(ctx: BotContext): DetecterService {
  if (!serviceInstance) serviceInstance = new DetecterService(ctx);
  return serviceInstance;
}

export function shutdownDetecterService(): void {
  serviceInstance?.dispose();
  serviceInstance = undefined;
}

export class DetecterService {
  private readonly pendingEvents: TtlStore<PunishmentEvent>;
  private readonly processedAuditIds = new TtlStore<true>(2 * 60 * 60 * 1000);
  private readonly recentKeys = new TtlStore<number>(10 * 60 * 1000);
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(private readonly ctx: BotContext) {
    this.pendingEvents = new TtlStore<PunishmentEvent>(ctx.config.DETECTER_PROMPT_TIMEOUT_SEC * 1000);
    this.cleanupTimer = setInterval(() => {
      this.pendingEvents.sweep();
      this.processedAuditIds.sweep();
      this.recentKeys.sweep();
    }, 30 * 1000);
    this.cleanupTimer.unref?.();
  }

  dispose(): void {
    clearInterval(this.cleanupTimer);
  }

  getPendingEvent(eventId: string): PunishmentEvent | undefined {
    return this.pendingEvents.get(eventId) ?? undefined;
  }

  private isRecentDuplicate(input: {
    guildId: string;
    userId: string;
    punishmentType: string;
    timeoutEnd: number;
  }): boolean {
    const now = Date.now();
    const bucket = Math.floor(now / 1000 / 15);
    const key = `${input.guildId}:${input.userId}:${input.punishmentType}:${input.timeoutEnd}:${bucket}`;
    const prev = this.recentKeys.get(key);
    this.recentKeys.set(key, now);
    return prev !== null && now - prev < 15 * 1000;
  }

  private async lookupAuditLog(input: {
    guild: Guild;
    action: AuditLogEvent;
    targetUserId: string;
    requireTimeoutChange?: boolean;
  }): Promise<AuditLookupResult | null> {
    return findAuditLogForTarget({
      ...input,
      auditWindowSec: this.ctx.config.DETECTER_AUDIT_WINDOW_SEC,
      defaultReasonText: this.ctx.config.DETECTER_DEFAULT_REASON_TEXT,
      isProcessedAuditId: (auditId) => this.processedAuditIds.has(auditId),
      warn: (meta, msg) => this.ctx.log.warn(meta, msg),
      debug: (meta, msg) => this.ctx.log.debug(meta, msg),
    });
  }

  private async resolveUser(userId: string): Promise<User | null> {
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
        return { actorId: input.actorId, actorDisplay: userDisplayName(actor), strictActor: true };
      }
    }

    const approvedById = extractPublicExecutionApprover(input.auditReason);
    if (approvedById) {
      const user = await this.resolveUser(approvedById);
      if (user) {
        return { actorId: approvedById, actorDisplay: userDisplayName(user), strictActor: true };
      }
    }

    for (const fallbackId of [input.guild.ownerId, normalizeSnowflake(this.ctx.config.OWNER_ID) ?? ""]) {
      if (!fallbackId) continue;
      const owner = await this.resolveUser(fallbackId);
      if (owner) {
        return { actorId: owner.id, actorDisplay: userDisplayName(owner), strictActor: false };
      }
    }

    return { actorId: "", actorDisplay: "不明", strictActor: false };
  }

  private async resolveLoggerChannel(guild: Guild): Promise<TextChannel | null> {
    const chId = resolveModLogChannelId(this.ctx.config);
    if (!chId) return null;

    let channel: Channel | undefined = guild.channels.cache.get(chId);
    if (!channel) {
      channel = (await this.ctx.client.channels.fetch(chId).catch(() => null)) ?? undefined;
    }
    if (!channel?.isTextBased()) return null;
    if ("guildId" in channel && String(channel.guildId) !== String(guild.id)) return null;
    return channel as TextChannel;
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

    const updatedCard = buildReasonPromptCard(event, reasonText, this.ctx.config.DETECTER_DEFAULT_REASON_TEXT);
    await message.edit(componentCardsPayload([updatedCard])).catch(() => undefined);
  }

  private async sendAuditReasonLoggedNotice(event: PunishmentEvent): Promise<boolean> {
    const guild = this.ctx.client.guilds.cache.get(event.guildId);
    if (!guild) return false;

    const promptChannel = await this.resolveLoggerChannel(guild);
    if (!promptChannel) {
      this.ctx.log.warn(
        { guildId: event.guildId, channelId: resolveModLogChannelId(this.ctx.config) },
        "detecter: mod log / logger channel not found (audit reason path)",
      );
      return false;
    }

    const card = buildAuditReasonLoggedCard(event, this.ctx.config.DETECTER_DEFAULT_REASON_TEXT);
    try {
      await promptChannel.send({ ...componentCardsPayload([card]), allowedMentions: { parse: [] } });
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
        { guildId: event.guildId, channelId: resolveModLogChannelId(this.ctx.config) },
        "detecter: mod log / logger channel not found or inaccessible",
      );
      return false;
    }

    const notice = `<@${event.actorUserId}>さん。<@${event.targetUserId}> への処罰理由を入力してください。`;
    const card = buildReasonPromptCard(event, event.detectedReason, this.ctx.config.DETECTER_DEFAULT_REASON_TEXT, notice);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`detecter:reasonPrompt:${event.eventId}`)
        .setLabel("理由を入力")
        .setStyle(ButtonStyle.Primary),
    );

    try {
      const sent = await promptChannel.send({
        ...componentCardsPayload([card], [row]),
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

  private async insertIncidentAndDmTarget(event: PunishmentEvent, finalReason: string): Promise<boolean> {
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
          created_at: nowIso() as unknown as Date,
        })
        .returning("id")
        .executeTakeFirst();
    } catch (err) {
      this.ctx.log.warn({ err, auditKey }, "detecter: insert incident failed");
    }

    const appealUrl = (await getGuildSettingsData(this.ctx.db, event.guildId)).appeal_instructions_url;
    const card = buildTargetPunishmentDmCard(event, reason, cfg.DETECTER_DEFAULT_REASON_TEXT, appealUrl);
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
      await target.send({ ...componentCardsPayload([card], appealComponents) });
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
    if (!event) return { message: "このイベントは期限切れか、既に処理済みです。" };
    if (moderatorUserId !== event.actorUserId) {
      return { message: "処罰を実行したユーザーのみ理由を送信できます。" };
    }
    if (event.reasonButtonFired) return { message: "この理由入力は既に処理済みです。" };

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
    targetUser: User;
    punishmentType: PunishmentType;
    timeoutEndDt: Date | null;
    auditResult: AuditLookupResult | null;
  }): Promise<void> {
    const { guild, targetUser, punishmentType, timeoutEndDt, auditResult } = input;
    const cfg = this.ctx.config;
    const now = new Date();
    const timeoutStart = Math.floor(now.getTime() / 1000);
    const timeoutEndDate = timeoutEndDt ?? new Date(now.getTime() + cfg.DETECTER_DEFAULT_APPEAL_WINDOW_SEC * 1000);
    let timeoutEnd = Math.floor(timeoutEndDate.getTime() / 1000);
    if (timeoutEnd <= timeoutStart) timeoutEnd = timeoutStart + 60;

    const auditActorId = auditResult ? (normalizeSnowflake(auditResult.actorId) ?? "") : "";
    const auditReason = auditResult?.reason ?? cfg.DETECTER_DEFAULT_REASON_TEXT;
    const hasExplicitAuditReason = auditResult?.hasExplicitAuditReason ?? false;
    const actor = await this.resolveActorForPrompt({ guild, actorId: auditActorId, auditReason });

    const auditId = auditResult ? (normalizeSnowflake(auditResult.auditId) ?? "") : "";
    if (auditId) this.processedAuditIds.set(auditId, true);

    if (this.isRecentDuplicate({ guildId: guild.id, userId: targetUser.id, punishmentType, timeoutEnd })) return;

    const eventId = `${guild.id}:${targetUser.id}:${punishmentType}:${timeoutStart}:${timeoutEnd}`;
    const event: PunishmentEvent = {
      eventId,
      punishmentType,
      guildId: guild.id,
      guildName: safeText(guild.name, `guild-${guild.id}`),
      targetUserId: normalizeSnowflake(targetUser.id) ?? "",
      targetDisplay: safeText(userDisplayName(targetUser), targetUser.id),
      actorUserId: normalizeSnowflake(actor.actorId) ?? "",
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
      const audit = await this.lookupAuditLog({
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
      if (!m?.user) return;
      const audit = await this.lookupAuditLog({
        guild: m.guild,
        action: AuditLogEvent.MemberKick,
        targetUserId: m.id,
      });
      if (!audit) return;
      await this.registerPunishment({
        guild: m.guild,
        targetUser: m.user,
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
      const now = new Date();
      const afterHasActiveTimeout = Boolean(afterUntil && afterUntil > now);
      const communicationTimeoutEndChanged = !beforeUntil || !afterUntil || afterUntil.getTime() !== beforeUntil.getTime();
      const v2PrimaryOk = afterHasActiveTimeout && communicationTimeoutEndChanged;

      let audit = await this.lookupAuditLog({
        guild: after.guild,
        action: AuditLogEvent.MemberUpdate,
        targetUserId: after.id,
        requireTimeoutChange: true,
      });

      const auditEnd = audit?.communicationDisabledUntilFromAudit ?? null;
      let timeoutEndDt: Date | null = v2PrimaryOk ? afterUntil : null;
      if (!timeoutEndDt && auditEnd && auditEnd > now && (!beforeUntil || auditEnd > beforeUntil || !afterUntil)) {
        timeoutEndDt = auditEnd;
      }
      if (!timeoutEndDt) return;

      if (!audit) {
        audit = await this.lookupAuditLog({
          guild: after.guild,
          action: AuditLogEvent.MemberUpdate,
          targetUserId: after.id,
          requireTimeoutChange: false,
        });
      }

      const targetUser = after.user ?? (await after.fetch().catch(() => null))?.user ?? null;
      if (!targetUser) return;

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

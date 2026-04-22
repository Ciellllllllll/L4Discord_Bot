import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  DiscordAPIError,
  EmbedBuilder,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type Message,
  type TextChannel,
} from "discord.js";
import { randomUUID } from "node:crypto";
import type { BotContext } from "../../bot/context.js";
import { sqliteTimestamp } from "../../core/db/sqliteTimestamp.js";
import { isAdmin } from "../../core/permission.js";
import { clampTimeoutMs, discordVoteDeadlineEmbedLine } from "./executionConstants.js";
import {
  TE_APPROVAL_PREFIX,
  TE_POLL1_KEYS,
  TE_POLL1_LABEL,
  TE_POLL2_KEYS,
  TE_POLL2_LABEL,
  TE_POLL2_SECONDS,
  TE_VOTE_PREFIX,
  TIMEOUT_EXTEND_FLOW_KIND,
} from "./timeoutExtendConstants.js";
import type { TimeoutExtendFlowState } from "./timeoutExtendFlow.types.js";
import { parseTimeoutExtendFlowState } from "./timeoutExtendFlow.types.js";

const teAdminWaitTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** `${guildId}:${targetId}` — 同一対象の重複開始防止 */
const activeTeTargets = new Set<string>();

type OpenTimeoutExtendFlowRow = {
  id: string;
  guild_id: string;
  status: string;
  message_id: string | null;
  state: unknown;
  updated_at: Date;
};

function teLockKey(guildId: string, targetId: string): string {
  return `${guildId}:${targetId}`;
}

function releaseTeLock(guildId: string, targetId: string): void {
  activeTeTargets.delete(teLockKey(guildId, targetId));
}

function clearTeAdminWait(flowId: string): void {
  const t = teAdminWaitTimers.get(flowId);
  if (t) clearTimeout(t);
  teAdminWaitTimers.delete(flowId);
}

function scheduleTePoll1Finalize(ctx: BotContext, flowId: string, guildId: string, delayMs: number): void {
  setTimeout(() => {
    void transitionTePoll1ToNext(ctx, flowId, guildId).catch((err) =>
      ctx.log.error({ err, flowId }, "timeoutExtend: poll1 finalize failed"),
    );
  }, Math.max(0, delayMs));
}

function scheduleTePoll2Finalize(ctx: BotContext, flowId: string, guildId: string, delayMs: number): void {
  setTimeout(() => {
    void transitionTePoll2ToAdmin(ctx, flowId, guildId).catch((err) =>
      ctx.log.error({ err, flowId }, "timeoutExtend: poll2 finalize failed"),
    );
  }, Math.max(0, delayMs));
}

function teAdminWaitDeadlineMs(updatedAt: Date, waitSeconds: number): number {
  const updatedAtMs = new Date(updatedAt).getTime();
  const base = Number.isFinite(updatedAtMs) ? updatedAtMs : Date.now();
  return base + waitSeconds * 1000;
}

function parsePollRowState(row: { state: unknown }): TimeoutExtendFlowState | null {
  const raw = row.state as unknown;
  const obj = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  return parseTimeoutExtendFlowState(obj);
}

export async function findOpenTimeoutExtendFlowById(
  ctx: BotContext,
  flowId: string,
): Promise<{ row: OpenTimeoutExtendFlowRow; state: TimeoutExtendFlowState } | null> {
  const row = await ctx.db
    .selectFrom("polls")
    .select(["id", "guild_id", "status", "message_id", "state", "updated_at"])
    .where("id", "=", flowId)
    .where("kind", "=", TIMEOUT_EXTEND_FLOW_KIND)
    .where("status", "=", "open")
    .executeTakeFirst();
  if (!row) return null;
  const state = parsePollRowState(row);
  if (!state) return null;
  return { row, state };
}

async function saveTeFullState(
  ctx: BotContext,
  flowId: string,
  state: TimeoutExtendFlowState,
  messageId: string | null,
): Promise<void> {
  await ctx.db
    .updateTable("polls")
    .set({
      state: JSON.stringify(state) as unknown as Record<string, unknown>,
      message_id: messageId,
      updated_at: sqliteTimestamp() as unknown as Date,
    })
    .where("id", "=", flowId)
    .execute();
}

export async function deleteTeFlowMessagesQuietly(
  ctx: BotContext,
  channel: TextChannel,
  messageIds: string[],
  logLabel: string,
): Promise<void> {
  for (const id of messageIds) {
    try {
      const m = await channel.messages.fetch(id).catch(() => null);
      if (m) await m.delete().catch(() => undefined);
    } catch (err) {
      ctx.log.warn({ err, id, logLabel }, "timeoutExtend: delete flow message failed");
    }
  }
}

function parseTeVote(customId: string): { flowId: string; choice: string } | null {
  if (!customId.startsWith(TE_VOTE_PREFIX)) return null;
  const rest = customId.slice(TE_VOTE_PREFIX.length);
  const idx = rest.lastIndexOf(":");
  if (idx <= 0) return null;
  return { flowId: rest.slice(0, idx), choice: rest.slice(idx + 1) };
}

function parseTeApproval(customId: string): { flowId: string; action: "approve" | "deny" } | null {
  if (!customId.startsWith(TE_APPROVAL_PREFIX)) return null;
  const rest = customId.slice(TE_APPROVAL_PREFIX.length);
  const idx = rest.lastIndexOf(":");
  if (idx <= 0) return null;
  const action = rest.slice(idx + 1);
  if (action !== "approve" && action !== "deny") return null;
  return { flowId: rest.slice(0, idx), action };
}

function tallyChoices(votes: Record<string, string>, keys: readonly string[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const k of keys) c[k] = 0;
  for (const v of Object.values(votes)) {
    if (v in c) c[v] = (c[v] ?? 0) + 1;
  }
  return c;
}

function pickSingleWinner(counts: Record<string, number>, keys: readonly string[]): string | null {
  let max = -1;
  const winners: string[] = [];
  for (const k of keys) {
    const n = counts[k] ?? 0;
    if (n > max) {
      max = n;
      winners.length = 0;
      winners.push(k);
    } else if (n === max && n >= 0) {
      winners.push(k);
    }
  }
  if (max <= 0 || winners.length !== 1) return null;
  return winners[0] ?? null;
}

const TIMEOUT_EXTEND_REASON_BASE = "/タイムアウト延長フロー";

function buildTimeoutExtendAuditReason(approverUserId: string, detailJa: string): string {
  const text = `${TIMEOUT_EXTEND_REASON_BASE}（${detailJa}）。管理者が承認。`;
  const suffix = ` approved_by=${approverUserId}`;
  const full = `${text}${suffix}`;
  const max = 512;
  if (full.length <= max) return full;
  const keep = max - suffix.length;
  return `${text.slice(0, Math.max(0, keep))}${suffix}`;
}

function durationLabelJa(sec: number | null): string {
  if (sec == null) return "";
  if (sec < 120) return `${sec}秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)}分`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}時間`;
  if (sec < 86400 * 7) return `${Math.floor(sec / 86400)}日`;
  return `${Math.floor(sec / (86400 * 7))}週間`;
}

function buildPoll1Embed(state: TimeoutExtendFlowState, poll1DeadlineMs: number, pollEnded = false): EmbedBuilder {
  const counts = tallyChoices(state.votes_poll1, [...TE_POLL1_KEYS]);
  const lines = TE_POLL1_KEYS.map((k) => `**${TE_POLL1_LABEL[k]}** — ${counts[k] ?? 0} 票`);
  return new EmbedBuilder()
    .setTitle("タイムアウト処理を選択")
    .setDescription(
      [`対象: <@${state.target_id}>`, "", ...lines, "", discordVoteDeadlineEmbedLine(poll1DeadlineMs, pollEnded)].join("\n"),
    )
    .setColor(0x3498db)
    .setTimestamp(new Date());
}

function buildPoll2Embed(state: TimeoutExtendFlowState, poll2DeadlineMs: number, pollEnded = false): EmbedBuilder {
  const counts = tallyChoices(state.votes_poll2, [...TE_POLL2_KEYS]);
  const lines = TE_POLL2_KEYS.map((k) => `**${TE_POLL2_LABEL[k]}** — ${counts[k] ?? 0} 票`);
  return new EmbedBuilder()
    .setTitle("延長時間を選択")
    .setDescription(
      [`対象: <@${state.target_id}>`, "", ...lines, "", discordVoteDeadlineEmbedLine(poll2DeadlineMs, pollEnded)].join("\n"),
    )
    .setColor(0x9b59b6)
    .setTimestamp(new Date());
}

function tePoll1Rows(flowId: string, disabled: boolean): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...TE_POLL1_KEYS.map((k) =>
      new ButtonBuilder()
        .setCustomId(`${TE_VOTE_PREFIX}${flowId}:${k}`)
        .setLabel(TE_POLL1_LABEL[k])
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
    ),
  );
  return [row];
}

function tePoll2Rows(flowId: string, disabled: boolean): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...TE_POLL2_KEYS.map((k) =>
      new ButtonBuilder()
        .setCustomId(`${TE_VOTE_PREFIX}${flowId}:${k}`)
        .setLabel(TE_POLL2_LABEL[k])
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
    ),
  );
  return [row];
}

function teApprovalRows(flowId: string, disabled: boolean): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${TE_APPROVAL_PREFIX}${flowId}:approve`)
        .setLabel("承認")
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`${TE_APPROVAL_PREFIX}${flowId}:deny`)
        .setLabel("非承認")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled),
    ),
  ];
}

async function editTeMessagesStopped(
  ctx: BotContext,
  channel: TextChannel,
  messageIds: (string | null | undefined)[],
  heading: string,
): Promise<void> {
  const content = `# **${heading}**`;
  for (const mid of messageIds) {
    if (!mid) continue;
    try {
      const m = await channel.messages.fetch(mid).catch(() => null);
      if (m) await m.edit({ content, embeds: [], components: [] }).catch(() => undefined);
    } catch (err) {
      ctx.log.warn({ err, mid }, "timeoutExtend: edit stopped message failed");
    }
  }
}

async function abortTeFlow(
  ctx: BotContext,
  flowId: string,
  guildId: string,
  state: TimeoutExtendFlowState,
  heading: string,
): Promise<void> {
  clearTeAdminWait(flowId);
  releaseTeLock(guildId, state.target_id);
  const ch = (await ctx.client.channels.fetch(state.channel_id).catch(() => null)) as TextChannel | null;
  if (ch?.isTextBased()) {
    await editTeMessagesStopped(ctx, ch, [state.poll1_message_id, state.poll2_message_id, state.admin_message_id], heading);
  }
  await ctx.db
    .updateTable("polls")
    .set({
      status: "cancelled",
      state: JSON.stringify({ ...state, phase: "cancelled" }) as unknown as Record<string, unknown>,
      updated_at: sqliteTimestamp() as unknown as Date,
    })
    .where("id", "=", flowId)
    .execute();
}

function scheduleTeAdminWait(
  ctx: BotContext,
  flowId: string,
  guildId: string,
  delayMs = ctx.config.TIMEOUT_EXTEND_ADMIN_WAIT_SECONDS * 1000,
): void {
  clearTeAdminWait(flowId);
  const h = setTimeout(() => {
    void (async () => {
      const found = await findOpenTimeoutExtendFlowById(ctx, flowId);
      if (!found || found.state.phase !== "admin_pending" || found.state.admin_button_fired) return;
      ctx.log.info({ flowId }, "timeoutExtend: admin wait timeout");
      await abortTeFlow(ctx, flowId, guildId, found.state, "タイムアウト延長フロー: 承認がタイムアウトしました");
    })().catch((err) => ctx.log.error({ err, flowId }, "timeoutExtend: admin timeout handler failed"));
  }, Math.max(0, delayMs));
  teAdminWaitTimers.set(flowId, h);
}

async function listOpenTimeoutExtendFlows(ctx: BotContext): Promise<OpenTimeoutExtendFlowRow[]> {
  return ctx.db
    .selectFrom("polls")
    .select(["id", "guild_id", "status", "message_id", "state", "updated_at"])
    .where("kind", "=", TIMEOUT_EXTEND_FLOW_KIND)
    .where("status", "=", "open")
    .execute() as Promise<OpenTimeoutExtendFlowRow[]>;
}

async function cancelMalformedTimeoutExtendFlow(ctx: BotContext, flowId: string): Promise<void> {
  await ctx.db
    .updateTable("polls")
    .set({
      status: "cancelled",
      updated_at: sqliteTimestamp() as unknown as Date,
    })
    .where("id", "=", flowId)
    .execute();
}

export async function reconcileTimeoutExtendFlows(ctx: BotContext): Promise<void> {
  const rows = await listOpenTimeoutExtendFlows(ctx);
  const now = Date.now();
  activeTeTargets.clear();

  for (const row of rows) {
    const state = parsePollRowState(row);
    if (!state) {
      ctx.log.warn({ flowId: row.id }, "timeoutExtend: cancelling malformed open flow");
      await cancelMalformedTimeoutExtendFlow(ctx, row.id);
      continue;
    }

    if (state.phase === "completed" || state.phase === "cancelled") {
      await ctx.db
        .updateTable("polls")
        .set({
          status: state.phase === "completed" ? "completed" : "cancelled",
          updated_at: sqliteTimestamp() as unknown as Date,
        })
        .where("id", "=", row.id)
        .execute();
      continue;
    }

    activeTeTargets.add(teLockKey(row.guild_id, state.target_id));

    if (state.phase === "admin_pending") {
      const waitDeadlineMs = teAdminWaitDeadlineMs(row.updated_at, ctx.config.TIMEOUT_EXTEND_ADMIN_WAIT_SECONDS);
      const remainingMs = waitDeadlineMs - now;
      if (remainingMs <= 0) {
        await abortTeFlow(ctx, row.id, row.guild_id, state, "繧ｿ繧､繝繧｢繧ｦ繝亥ｻｶ髟ｷ繝輔Ο繝ｼ: 再起動後の復元時に期限切れを検出");
        continue;
      }
      scheduleTeAdminWait(ctx, row.id, row.guild_id, remainingMs);
      continue;
    }

    if (state.phase === "poll1_pending") {
      const remainingMs = state.poll1_deadline_ms - now;
      if (remainingMs <= 0) {
        await transitionTePoll1ToNext(ctx, row.id, row.guild_id);
        continue;
      }
      scheduleTePoll1Finalize(ctx, row.id, row.guild_id, remainingMs);
      continue;
    }

    if (state.phase === "poll2_pending") {
      const remainingMs = (state.poll2_deadline_ms ?? 0) - now;
      if (remainingMs <= 0) {
        await transitionTePoll2ToAdmin(ctx, row.id, row.guild_id);
        continue;
      }
      scheduleTePoll2Finalize(ctx, row.id, row.guild_id, remainingMs);
    }
  }
}

async function postTeAdminRequest(ctx: BotContext, channel: TextChannel, flowId: string, body: string): Promise<Message | null> {
  const adminRoleId = ctx.config.ADMIN_ROLE_ID.trim();
  try {
    return await channel.send({
      content: `${body}\n<@&${adminRoleId}>`,
      components: teApprovalRows(flowId, false),
      allowedMentions: { roles: [adminRoleId] },
    });
  } catch (err) {
    ctx.log.warn({ err, flowId }, "timeoutExtend: admin request send failed");
    return null;
  }
}

async function beginTePoll1(ctx: BotContext, flowId: string, guildId: string, state: TimeoutExtendFlowState): Promise<void> {
  const ch = (await ctx.client.channels.fetch(state.channel_id).catch(() => null)) as TextChannel | null;
  if (!ch?.isTextBased()) return;

  const voteMs = ctx.config.EXEC_VOTE_SECONDS * 1000;
  const deadline = Date.now() + voteMs;
  const draft: TimeoutExtendFlowState = {
    ...state,
    poll1_deadline_ms: deadline,
    votes_poll1: {},
    phase: "poll1_pending",
  };
  const embed = buildPoll1Embed(draft, deadline);

  let msg: Message;
  try {
    msg = await ch.send({
      embeds: [embed],
      components: tePoll1Rows(flowId, false),
      allowedMentions: { users: [state.target_id] },
    });
  } catch (err) {
    ctx.log.error({ err, flowId }, "timeoutExtend: poll1 send failed");
    await abortTeFlow(ctx, flowId, guildId, state, "タイムアウト延長フロー: 投票メッセージの送信に失敗しました");
    return;
  }

  const next: TimeoutExtendFlowState = {
    ...state,
    phase: "poll1_pending",
    poll1_message_id: msg.id,
    poll1_deadline_ms: deadline,
    votes_poll1: {},
  };
  await saveTeFullState(ctx, flowId, next, msg.id);
  scheduleTePoll1Finalize(ctx, flowId, guildId, voteMs);
}

async function transitionTePoll1ToNext(ctx: BotContext, flowId: string, guildId: string): Promise<void> {
  const found = await findOpenTimeoutExtendFlowById(ctx, flowId);
  if (!found || found.state.phase !== "poll1_pending") return;

  const { state } = found;

  const counts = tallyChoices(state.votes_poll1, [...TE_POLL1_KEYS]);
  const winner = pickSingleWinner(counts, [...TE_POLL1_KEYS]);
  const ch = (await ctx.client.channels.fetch(state.channel_id).catch(() => null)) as TextChannel | null;
  if (!ch?.isTextBased()) return;

  if (state.poll1_message_id) {
    try {
      const m = await ch.messages.fetch(state.poll1_message_id).catch(() => null);
      if (m) {
        await m.edit({
          embeds: [buildPoll1Embed(state, state.poll1_deadline_ms, true)],
          components: tePoll1Rows(flowId, true),
        });
      }
    } catch {
      /* noop */
    }
  }

  if (winner == null) {
    await abortTeFlow(ctx, flowId, guildId, state, "タイムアウト延長フロー: 投票の最多票が確定しませんでした");
    return;
  }

  if (winner === "release") {
    const adminMsg = await postTeAdminRequest(
      ctx,
      ch,
      flowId,
      `タイムアウト延長フロー — 最終承認: <@${state.target_id}> の **タイムアウト解除**`,
    );
    const next: TimeoutExtendFlowState = {
      ...state,
      phase: "admin_pending",
      resolved_extend: "release",
      duration_seconds: null,
      admin_message_id: adminMsg?.id ?? null,
    };
    await saveTeFullState(ctx, flowId, next, null);
    scheduleTeAdminWait(ctx, flowId, guildId);
    return;
  }

  const voteMs = ctx.config.EXEC_VOTE_SECONDS * 1000;
  const deadline = Date.now() + voteMs;
  const embed = buildPoll2Embed(
    {
      ...state,
      phase: "poll2_pending",
      poll2_deadline_ms: deadline,
      votes_poll2: {},
      resolved_extend: "extend",
    },
    deadline,
  );

  let msg: Message;
  try {
    msg = await ch.send({
      embeds: [embed],
      components: tePoll2Rows(flowId, false),
      allowedMentions: { users: [state.target_id] },
    });
  } catch (err) {
    ctx.log.error({ err, flowId }, "timeoutExtend: poll2 send failed");
    await abortTeFlow(ctx, flowId, guildId, state, "タイムアウト延長フロー: 延長時間投票の送信に失敗しました");
    return;
  }

  const next: TimeoutExtendFlowState = {
    ...state,
    phase: "poll2_pending",
    resolved_extend: "extend",
    poll2_message_id: msg.id,
    poll2_deadline_ms: deadline,
    votes_poll2: {},
  };
  await saveTeFullState(ctx, flowId, next, msg.id);
  scheduleTePoll2Finalize(ctx, flowId, guildId, voteMs);
}

async function transitionTePoll2ToAdmin(ctx: BotContext, flowId: string, guildId: string): Promise<void> {
  const found = await findOpenTimeoutExtendFlowById(ctx, flowId);
  if (!found || found.state.phase !== "poll2_pending") return;

  const { state } = found;

  const counts = tallyChoices(state.votes_poll2, [...TE_POLL2_KEYS]);
  const winner = pickSingleWinner(counts, [...TE_POLL2_KEYS]);
  const ch = (await ctx.client.channels.fetch(state.channel_id).catch(() => null)) as TextChannel | null;
  if (!ch?.isTextBased()) return;

  if (state.poll2_message_id && state.poll2_deadline_ms) {
    try {
      const m = await ch.messages.fetch(state.poll2_message_id).catch(() => null);
      if (m) {
        await m.edit({
          embeds: [buildPoll2Embed(state, state.poll2_deadline_ms, true)],
          components: tePoll2Rows(flowId, true),
        });
      }
    } catch {
      /* noop */
    }
  }

  if (winner == null) {
    await abortTeFlow(ctx, flowId, guildId, state, "タイムアウト延長フロー: 延長時間の最多票が確定しませんでした");
    return;
  }

  const sec = TE_POLL2_SECONDS[winner as keyof typeof TE_POLL2_SECONDS];
  const durationSeconds = sec ?? 3600;
  const label = TE_POLL2_LABEL[winner as keyof typeof TE_POLL2_LABEL] ?? winner;

  const adminMsg = await postTeAdminRequest(
    ctx,
    ch,
    flowId,
    `タイムアウト延長フロー — 最終承認: <@${state.target_id}> の **タイムアウト延長（${label}）**`,
  );
  const next: TimeoutExtendFlowState = {
    ...state,
    phase: "admin_pending",
    resolved_extend: "extend",
    duration_seconds: durationSeconds,
    admin_message_id: adminMsg?.id ?? null,
  };
  await saveTeFullState(ctx, flowId, next, null);
  scheduleTeAdminWait(ctx, flowId, guildId);
}

async function resolveVoteTextChannel(
  ctx: BotContext,
  guild: Guild,
  interaction: ChatInputCommandInteraction,
): Promise<TextChannel | null> {
  const configured = ctx.config.TIMEOUT_EXTEND_VOTE_CHANNEL_ID?.trim();
  if (configured) {
    const ch = await guild.channels.fetch(configured).catch(() => null);
    if (ch?.isTextBased() && !ch.isDMBased()) return ch as TextChannel;
    return null;
  }
  const ch = interaction.channel;
  if (ch?.isTextBased() && !ch.isDMBased()) return ch as TextChannel;
  return null;
}

async function applyTimeoutResolution(
  guild: Guild,
  targetId: string,
  resolved: "extend" | "release",
  durationSeconds: number | null,
  reason: string,
  ctx: BotContext,
): Promise<{ ok: true } | { ok: false; message: string }> {
  let member: GuildMember;
  try {
    member = await guild.members.fetch(targetId);
  } catch {
    return { ok: false, message: "対象メンバーが見つかりません（退出済みなど）。" };
  }

  try {
    if (resolved === "release") {
      await member.timeout(null, reason);
      return { ok: true };
    }
    const addSec = durationSeconds ?? 3600;
    const now = Date.now();
    const curUntil = member.communicationDisabledUntil?.getTime() ?? now;
    const base = Math.max(now, curUntil);
    const newUntil = base + addSec * 1000;
    let ms = newUntil - now;
    if (!Number.isFinite(ms) || ms <= 0) ms = 60_000;
    ms = clampTimeoutMs(ms);
    await member.timeout(ms, reason);
    return { ok: true };
  } catch (err) {
    ctx.log.warn({ err, targetId, resolved }, "timeoutExtend: apply failed");
    if (err instanceof DiscordAPIError) {
      return { ok: false, message: `Discord API: ${err.message}` };
    }
    return { ok: false, message: String(err) };
  }
}

export async function startTimeoutExtendFlow(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply({ content: "サーバー内でのみ実行できます。" });
    return;
  }

  const execCh = ctx.config.EXEC_CHANNEL_ID?.trim();
  if (execCh && interaction.channelId !== execCh) {
    await interaction.editReply({ content: "このコマンドは指定チャンネルでのみ使用できます。" });
    return;
  }

  let invokerMember: GuildMember;
  try {
    invokerMember = await guild.members.fetch(interaction.user.id);
  } catch {
    await interaction.editReply({ content: "メンバー情報を取得できませんでした。" });
    return;
  }
  if (!isAdmin(invokerMember, ctx.config)) {
    await interaction.editReply({ content: "権限がありません。" });
    return;
  }

  const targetUser = interaction.options.getUser("target", true);

  let targetMember: GuildMember;
  try {
    targetMember = await guild.members.fetch(targetUser.id);
  } catch {
    await interaction.editReply({ content: "対象メンバーを取得できませんでした。" });
    return;
  }

  const until = targetMember.communicationDisabledUntil;
  if (!until || until.getTime() <= Date.now()) {
    await interaction.editReply({ content: "対象は現在有効なタイムアウト状態ではありません。" });
    return;
  }

  const voteChannel = await resolveVoteTextChannel(ctx, guild, interaction);
  if (!voteChannel) {
    await interaction.editReply({
      content: ctx.config.TIMEOUT_EXTEND_VOTE_CHANNEL_ID?.trim()
        ? "投票投稿先チャンネル（TIMEOUT_EXTEND_VOTE_CHANNEL_ID）を取得できませんでした。"
        : "このチャンネルでは実行できません。",
    });
    return;
  }

  const lockKey = teLockKey(guild.id, targetUser.id);
  if (activeTeTargets.has(lockKey)) {
    await interaction.editReply({ content: "この対象では既にタイムアウト延長フローが進行中です。" });
    return;
  }

  const flowId = randomUUID();
  const baseState: TimeoutExtendFlowState = {
    phase: "poll1_pending",
    invoker_id: interaction.user.id,
    target_id: targetUser.id,
    channel_id: voteChannel.id,
    poll1_message_id: null,
    poll2_message_id: null,
    admin_message_id: null,
    votes_poll1: {},
    votes_poll2: {},
    poll1_deadline_ms: 0,
    poll2_deadline_ms: null,
    resolved_extend: null,
    duration_seconds: null,
    admin_button_fired: false,
  };

  activeTeTargets.add(lockKey);

  await ctx.db
    .insertInto("polls")
    .values({
      id: flowId,
      guild_id: guild.id,
      channel_id: voteChannel.id,
      message_id: null,
      kind: TIMEOUT_EXTEND_FLOW_KIND,
      status: "open",
      state: JSON.stringify(baseState) as unknown as Record<string, unknown>,
      ends_at: null,
      created_at: sqliteTimestamp() as unknown as Date,
      updated_at: sqliteTimestamp() as unknown as Date,
    })
    .execute();

  try {
    await beginTePoll1(ctx, flowId, guild.id, baseState);
  } catch (err) {
    releaseTeLock(guild.id, targetUser.id);
    await ctx.db.deleteFrom("polls").where("id", "=", flowId).execute().catch(() => undefined);
    ctx.log.error({ err, flowId }, "timeoutExtend: begin failed");
    await interaction.editReply({ content: "フローの開始に失敗しました。" });
    return;
  }

  await interaction.editReply({
    content: `タイムアウト延長の投票を開始しました（投稿先: <#${voteChannel.id}>）。`,
  });
}

async function handleTeVote(interaction: ButtonInteraction, ctx: BotContext): Promise<boolean> {
  const parsed = parseTeVote(interaction.customId);
  if (!parsed) return false;

  if (interaction.user.bot) {
    await interaction.reply({ content: "BOT は投票できません。", flags: MessageFlags.Ephemeral });
    return true;
  }

  const { flowId, choice } = parsed;
  const found = await findOpenTimeoutExtendFlowById(ctx, flowId);
  if (!found) {
    await interaction.reply({ content: "この投票は終了しているか、無効です。", flags: MessageFlags.Ephemeral });
    return true;
  }

  const { state, row } = found;
  if (interaction.channelId !== state.channel_id || interaction.guildId !== row.guild_id) {
    await interaction.reply({ content: "このチャンネルでは投票できません。", flags: MessageFlags.Ephemeral });
    return true;
  }

  if (state.phase === "poll1_pending") {
    if (!TE_POLL1_KEYS.includes(choice as (typeof TE_POLL1_KEYS)[number])) {
      await interaction.reply({ content: "無効な選択です。", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (Date.now() > state.poll1_deadline_ms) {
      await interaction.reply({ content: "締切を過ぎています。", flags: MessageFlags.Ephemeral });
      return true;
    }
    const prev = state.votes_poll1[interaction.user.id];
    const votes = { ...state.votes_poll1, [interaction.user.id]: choice } as TimeoutExtendFlowState["votes_poll1"];
    const next: TimeoutExtendFlowState = { ...state, votes_poll1: votes };
    await saveTeFullState(ctx, flowId, next, state.poll1_message_id);

    const label = TE_POLL1_LABEL[choice as keyof typeof TE_POLL1_LABEL];
    const text =
      prev === undefined
        ? "投票しました。"
        : prev === choice
          ? `既に投票先は ${label} です。`
          : `投票先を ${label} に変更しました。`;
    await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });

    const ch = interaction.channel;
    if (ch?.isTextBased() && !ch.isDMBased() && state.poll1_message_id) {
      try {
        const m = await (ch as TextChannel).messages.fetch(state.poll1_message_id);
        await m.edit({
          embeds: [buildPoll1Embed(next, next.poll1_deadline_ms)],
          components: tePoll1Rows(flowId, false),
        });
      } catch (err) {
        ctx.log.warn({ err, flowId }, "timeoutExtend: poll1 edit failed");
      }
    }
    return true;
  }

  if (state.phase === "poll2_pending") {
    if (!TE_POLL2_KEYS.includes(choice as (typeof TE_POLL2_KEYS)[number])) {
      await interaction.reply({ content: "無効な選択です。", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (!state.poll2_deadline_ms || Date.now() > state.poll2_deadline_ms) {
      await interaction.reply({ content: "締切を過ぎています。", flags: MessageFlags.Ephemeral });
      return true;
    }
    const prev = state.votes_poll2[interaction.user.id];
    const votes = { ...state.votes_poll2, [interaction.user.id]: choice } as TimeoutExtendFlowState["votes_poll2"];
    const next: TimeoutExtendFlowState = { ...state, votes_poll2: votes };
    await saveTeFullState(ctx, flowId, next, state.poll2_message_id);

    const label = TE_POLL2_LABEL[choice as keyof typeof TE_POLL2_LABEL];
    const text =
      prev === undefined
        ? "投票しました。"
        : prev === choice
          ? `既に投票先は ${label} です。`
          : `投票先を ${label} に変更しました。`;
    await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });

    const ch = interaction.channel;
    if (ch?.isTextBased() && !ch.isDMBased() && state.poll2_message_id) {
      try {
        const m = await (ch as TextChannel).messages.fetch(state.poll2_message_id);
        await m.edit({
          embeds: [buildPoll2Embed(next, next.poll2_deadline_ms!)],
          components: tePoll2Rows(flowId, false),
        });
      } catch (err) {
        ctx.log.warn({ err, flowId }, "timeoutExtend: poll2 edit failed");
      }
    }
    return true;
  }

  await interaction.reply({ content: "この投票は終了しています。", flags: MessageFlags.Ephemeral });
  return true;
}

function buildResolvedDetailJa(state: TimeoutExtendFlowState): string {
  const r = state.resolved_extend;
  if (r === "release") return "タイムアウト解除";
  const sec = state.duration_seconds;
  return sec == null ? "タイムアウト延長" : `タイムアウト延長（${durationLabelJa(sec)}）`;
}

async function handleTeApproval(interaction: ButtonInteraction, ctx: BotContext): Promise<boolean> {
  const parsed = parseTeApproval(interaction.customId);
  if (!parsed) return false;

  const { flowId, action } = parsed;
  const found = await findOpenTimeoutExtendFlowById(ctx, flowId);
  if (!found) {
    await interaction.reply({ content: "このフローは期限切れか、既に処理済みです。", flags: MessageFlags.Ephemeral });
    return true;
  }

  const { row, state } = found;
  const guild = interaction.guild;
  if (!guild || interaction.channelId !== state.channel_id || interaction.guildId !== row.guild_id) {
    await interaction.reply({ content: "このチャンネルでは操作できません。", flags: MessageFlags.Ephemeral });
    return true;
  }

  let operatorMember: GuildMember;
  try {
    operatorMember = await guild.members.fetch(interaction.user.id);
  } catch {
    await interaction.reply({ content: "メンバー情報を取得できませんでした。", flags: MessageFlags.Ephemeral });
    return true;
  }

  if (!isAdmin(operatorMember, ctx.config)) {
    await interaction.reply({ content: "管理者のみ操作できます。", flags: MessageFlags.Ephemeral });
    return true;
  }

  if (state.phase !== "admin_pending") {
    await interaction.reply({ content: "このフローはこの操作の段階ではありません。", flags: MessageFlags.Ephemeral });
    return true;
  }
  if (state.admin_button_fired) {
    await interaction.reply({ content: "すでに処理済みです。", flags: MessageFlags.Ephemeral });
    return true;
  }

  await interaction.update({ components: teApprovalRows(flowId, true) }).catch(() => undefined);
  clearTeAdminWait(flowId);

  const approverId = interaction.user.id;
  const textChannel = interaction.channel as TextChannel;

  const idsToDelete = [state.poll1_message_id, state.poll2_message_id, state.admin_message_id].filter((x): x is string => Boolean(x));

  const nextFired: TimeoutExtendFlowState = { ...state, admin_button_fired: true };

  if (action === "deny") {
    try {
      await textChannel.send({ content: "タイムアウト延長フローが非承認されたため、中止します。" });
    } catch (err) {
      ctx.log.warn({ err, flowId }, "timeoutExtend: abort message failed");
    }
    await deleteTeFlowMessagesQuietly(ctx, textChannel, idsToDelete, "deny");
    releaseTeLock(row.guild_id, state.target_id);
    await ctx.db
      .updateTable("polls")
      .set({
        status: "cancelled",
        state: JSON.stringify({ ...nextFired, phase: "cancelled" }) as unknown as Record<string, unknown>,
        updated_at: sqliteTimestamp() as unknown as Date,
      })
      .where("id", "=", flowId)
      .execute();
    ctx.log.info({ flowId, approverId }, "timeoutExtend: final deny");
    return true;
  }

  const resolved = state.resolved_extend;
  if (resolved !== "extend" && resolved !== "release") {
    releaseTeLock(row.guild_id, state.target_id);
    await ctx.db
      .updateTable("polls")
      .set({ status: "cancelled", updated_at: sqliteTimestamp() as unknown as Date })
      .where("id", "=", flowId)
      .execute();
    return true;
  }

  const reason = buildTimeoutExtendAuditReason(approverId, buildResolvedDetailJa(state));
  const result = await applyTimeoutResolution(guild, state.target_id, resolved, state.duration_seconds, reason, ctx);

  const detailJa = buildResolvedDetailJa(state);

  if (result.ok) {
    const line =
      resolved === "release"
        ? `# <@${state.target_id}> のタイムアウトを **解除** しました`
        : `# <@${state.target_id}> のタイムアウトを **延長** しました（${durationLabelJa(state.duration_seconds)}）`;
    try {
      await textChannel.send({
        content: line,
        allowedMentions: { users: [state.target_id] },
      });
    } catch (err) {
      ctx.log.warn({ err, flowId }, "timeoutExtend: result message failed");
    }
  } else {
    try {
      await textChannel.send({ content: `タイムアウト処理の実行に失敗しました: ${result.message}` });
    } catch (err) {
      ctx.log.warn({ err, flowId }, "timeoutExtend: error message failed");
    }
  }

  await deleteTeFlowMessagesQuietly(ctx, textChannel, idsToDelete, "approve");
  releaseTeLock(row.guild_id, state.target_id);

  await ctx.db
    .updateTable("polls")
    .set({
      status: "completed",
      state: JSON.stringify({ ...nextFired, phase: "completed" }) as unknown as Record<string, unknown>,
      updated_at: sqliteTimestamp() as unknown as Date,
    })
    .where("id", "=", flowId)
    .execute();

  ctx.log.info({ flowId, approverId, resolved, detailJa, ok: result.ok }, "timeoutExtend: approved");
  return true;
}

export async function handleTimeoutExtendFlowButton(interaction: ButtonInteraction, ctx: BotContext): Promise<boolean> {
  if (interaction.customId.startsWith(TE_VOTE_PREFIX)) {
    return handleTeVote(interaction, ctx);
  }
  if (interaction.customId.startsWith(TE_APPROVAL_PREFIX)) {
    return handleTeApproval(interaction, ctx);
  }
  return false;
}

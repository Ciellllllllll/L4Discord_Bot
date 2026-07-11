import { ComponentCardBuilder, componentCardsPayload } from "../panels/componentCard.js";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  DiscordAPIError,
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
import {
  FlowDeadlineTimers,
  FlowOrchestrator,
  type FlowRuntimeRow,
  PollFlowStateStore,
  flowTargetLocks,
  normalizePollStateRevision,
  parsePersistedFlowState,
  pickSingleWinner,
  persistTerminalState,
  publishReservedPollMessage,
  saveOpenPollState,
  claimPollAdminApproval,
  commitClaimedPollTerminal,
  tallyChoices,
} from "./flowLifecycle.js";

const TIMEOUT_EXTEND_LOCK_NAMESPACE = "timeout-extend";
const timeoutExtendTimers = new FlowDeadlineTimers<ReturnType<typeof setTimeout>>({ setTimeout, clearTimeout });
const timeoutExtendFlowTargets = new Map<string, { guildId: string; targetId: string }>();

type OpenTimeoutExtendFlowRow = {
  id: string;
  guild_id: string;
  status: string;
  message_id: string | null;
  state: unknown;
  state_revision: number;
  updated_at: Date;
};

function teTimerKey(phase: "poll1" | "poll2" | "admin", flowId: string): string {
  return `${phase}:${flowId}`;
}

function retainTimeoutExtendTarget(flowId: string, guildId: string, targetId: string): boolean {
  const current = timeoutExtendFlowTargets.get(flowId);
  if (current) return current.guildId === guildId && current.targetId === targetId;
  if (!flowTargetLocks.acquire(TIMEOUT_EXTEND_LOCK_NAMESPACE, guildId, targetId)) return false;
  timeoutExtendFlowTargets.set(flowId, { guildId, targetId });
  return true;
}

function releaseTimeoutExtendTarget(flowId: string): void {
  const target = timeoutExtendFlowTargets.get(flowId);
  if (!target) return;
  flowTargetLocks.release(TIMEOUT_EXTEND_LOCK_NAMESPACE, target.guildId, target.targetId);
  timeoutExtendFlowTargets.delete(flowId);
}

/** プロセス終了時に、このランタイムが保持する延長フローの期限タイマーと対象ロックを解放する。 */
export function shutdownTimeoutExtendFlowRuntime(): void {
  timeoutExtendTimers.clearAll();
  for (const flowId of [...timeoutExtendFlowTargets.keys()]) releaseTimeoutExtendTarget(flowId);
}

async function commitTimeoutExtendTerminal(
  ctx: BotContext,
  flowId: string,
  phase: string,
  persist: () => Promise<unknown>,
  fallbackGuildId?: string,
): Promise<boolean> {
  const guildId = timeoutExtendFlowTargets.get(flowId)?.guildId ?? fallbackGuildId ?? "unknown";
  const result = await persistTerminalState(persist, () => {
    clearTimeoutExtendTimers(flowId);
    releaseTimeoutExtendTarget(flowId);
  });
  if (!result.ok) {
    ctx.log.error({ err: result.error, flowId, phase, guildId }, "timeoutExtend: terminal state persistence failed");
  }
  return result.ok;
}

export async function claimTimeoutExtendApproval(ctx: BotContext, row: OpenTimeoutExtendFlowRow, state: TimeoutExtendFlowState): Promise<boolean> {
  try {
    return await claimPollAdminApproval({
      store: new PollFlowStateStore(ctx.db), id: row.id, state, stateRevision: row.state_revision ?? 0, rawState: row.state,
    });
  } catch (err) {
    ctx.log.error({ err, flowId: row.id, phase: state.phase, guildId: row.guild_id }, "timeoutExtend: approval claim failed");
    throw err;
  }
}

export async function tryClaimTimeoutExtendApproval(
  ctx: BotContext,
  row: OpenTimeoutExtendFlowRow,
  state: TimeoutExtendFlowState,
): Promise<{ ok: true; claimed: boolean } | { ok: false; error: unknown }> {
  try {
    return { ok: true, claimed: await claimTimeoutExtendApproval(ctx, row, state) };
  } catch (error) {
    return { ok: false, error };
  }
}

async function commitClaimedTimeoutExtendTerminal(
  ctx: BotContext,
  row: OpenTimeoutExtendFlowRow,
  state: TimeoutExtendFlowState,
  terminalPhase: "completed" | "cancelled",
): Promise<boolean> {
  return commitTimeoutExtendTerminal(ctx, row.id, state.phase, async () => {
    const committed = await commitClaimedPollTerminal({
      store: new PollFlowStateStore(ctx.db), id: row.id, state, stateRevision: row.state_revision, terminalPhase,
    });
    if (!committed) throw new Error("timeout extend flow terminal CAS lost");
  }, row.guild_id);
}

function clearTimeoutExtendTimers(flowId: string): void {
  timeoutExtendTimers.clear(teTimerKey("poll1", flowId));
  timeoutExtendTimers.clear(teTimerKey("poll2", flowId));
  timeoutExtendTimers.clear(teTimerKey("admin", flowId));
}

function scheduleTePoll1Finalize(ctx: BotContext, flowId: string, guildId: string, delayMs: number): void {
  timeoutExtendOrchestrator.schedulePoll1(ctx, flowId, guildId, delayMs);
}

function scheduleTePoll2Finalize(ctx: BotContext, flowId: string, guildId: string, delayMs: number): void {
  timeoutExtendOrchestrator.schedulePoll2(ctx, flowId, guildId, delayMs);
}

function teAdminWaitDeadlineMs(updatedAt: Date, waitSeconds: number): number {
  const updatedAtMs = new Date(updatedAt).getTime();
  const base = Number.isFinite(updatedAtMs) ? updatedAtMs : Date.now();
  return base + waitSeconds * 1000;
}

function parsePollRowState(row: { state: unknown }): TimeoutExtendFlowState | null {
  return parsePersistedFlowState(row.state, parseTimeoutExtendFlowState);
}

export async function findOpenTimeoutExtendFlowById(
  ctx: BotContext,
  flowId: string,
): Promise<{ row: OpenTimeoutExtendFlowRow; state: TimeoutExtendFlowState } | null> {
  const row = await ctx.db
    .selectFrom("polls")
    .select(["id", "guild_id", "status", "message_id", "state", "state_revision", "updated_at"])
    .where("id", "=", flowId)
    .where("kind", "=", TIMEOUT_EXTEND_FLOW_KIND)
    .where("status", "=", "open")
    .executeTakeFirst();
  if (!row) return null;
  const stateRevision = normalizePollStateRevision(row.state_revision);
  if (stateRevision === null) {
    ctx.log.error({ flowId, guildId: row.guild_id, phase: "invalid_state_revision", stateRevision: row.state_revision }, "timeoutExtend: ignoring unsafe flow state revision");
    return null;
  }
  const state = parsePollRowState(row);
  if (!state) return null;
  return { row: { ...row, state_revision: stateRevision }, state };
}

async function saveTeFullState(
  ctx: BotContext,
  flowId: string,
  state: TimeoutExtendFlowState,
  messageId: string | null,
  expected?: OpenTimeoutExtendFlowRow,
): Promise<boolean> {
  return saveOpenPollState({
    store: new PollFlowStateStore(ctx.db),
    id: flowId,
    kind: TIMEOUT_EXTEND_FLOW_KIND,
    parse: parseTimeoutExtendFlowState,
    nextState: state,
    messageId,
    ...(expected ? { expected: { state: parsePollRowState(expected) ?? state, state_revision: expected.state_revision, rawState: expected.state } } : {}),
  });
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

export function parseTimeoutExtendVoteCustomId(customId: string): { flowId: string; choice: string } | null {
  if (!customId.startsWith(TE_VOTE_PREFIX)) return null;
  const rest = customId.slice(TE_VOTE_PREFIX.length);
  const idx = rest.lastIndexOf(":");
  if (idx <= 0) return null;
  return { flowId: rest.slice(0, idx), choice: rest.slice(idx + 1) };
}

export function parseTimeoutExtendApprovalCustomId(customId: string): { flowId: string; action: "approve" | "deny" } | null {
  if (!customId.startsWith(TE_APPROVAL_PREFIX)) return null;
  const rest = customId.slice(TE_APPROVAL_PREFIX.length);
  const idx = rest.lastIndexOf(":");
  if (idx <= 0) return null;
  const action = rest.slice(idx + 1);
  if (action !== "approve" && action !== "deny") return null;
  return { flowId: rest.slice(0, idx), action };
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

function buildPoll1Embed(state: TimeoutExtendFlowState, poll1DeadlineMs: number, pollEnded = false): ComponentCardBuilder {
  const counts = tallyChoices(state.votes_poll1, [...TE_POLL1_KEYS]);
  const lines = TE_POLL1_KEYS.map((k) => `**${TE_POLL1_LABEL[k]}** — ${counts[k] ?? 0} 票`);
  return new ComponentCardBuilder()
    .setTitle("タイムアウト処理を選択")
    .setDescription(
      [`対象: <@${state.target_id}>`, "", ...lines, "", discordVoteDeadlineEmbedLine(poll1DeadlineMs, pollEnded)].join("\n"),
    )
    .setTimestamp(new Date());
}

function buildPoll2Embed(state: TimeoutExtendFlowState, poll2DeadlineMs: number, pollEnded = false): ComponentCardBuilder {
  const counts = tallyChoices(state.votes_poll2, [...TE_POLL2_KEYS]);
  const lines = TE_POLL2_KEYS.map((k) => `**${TE_POLL2_LABEL[k]}** — ${counts[k] ?? 0} 票`);
  return new ComponentCardBuilder()
    .setTitle("延長時間を選択")
    .setDescription(
      [`対象: <@${state.target_id}>`, "", ...lines, "", discordVoteDeadlineEmbedLine(poll2DeadlineMs, pollEnded)].join("\n"),
    )
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
  messages: Array<{ id: string | null | undefined; components: ActionRowBuilder<ButtonBuilder>[] }>,
  heading: string,
): Promise<void> {
  const content = `# **${heading}**`;
  for (const { id: mid, components } of messages) {
    if (!mid) continue;
    try {
      const m = await channel.messages.fetch(mid).catch(() => null);
      if (m) await m.edit({ content, embeds: [], components }).catch(() => undefined);
    } catch (err) {
      ctx.log.warn({ err, mid }, "timeoutExtend: edit stopped message failed");
    }
  }
}

export async function abortTeFlow(
  ctx: BotContext,
  flowId: string,
  state: TimeoutExtendFlowState,
  heading: string,
  guildId?: string,
  expected?: OpenTimeoutExtendFlowRow,
): Promise<boolean> {
  let committedState: TimeoutExtendFlowState | null = null;
  const committed = await commitTimeoutExtendTerminal(ctx, flowId, state.phase, async () => {
    const current = await new PollFlowStateStore(ctx.db).cancelOpenFlow({
      id: flowId,
      kind: TIMEOUT_EXTEND_FLOW_KIND,
      expectedPhase: state.phase,
      parse: parseTimeoutExtendFlowState,
      ...(expected ? { expected: { state, stateRevision: expected.state_revision, rawState: expected.state } } : {}),
      canCancel: (currentState) => currentState.admin_button_fired === false,
    });
    if (!current) throw new Error("timeout extend flow terminal CAS lost");
    committedState = current;
  }, guildId);
  if (!committed) return false;
  const finalState = committedState ?? state;
  const ch = (await ctx.client.channels.fetch(finalState.channel_id).catch(() => null)) as TextChannel | null;
  if (ch?.isTextBased()) {
    await editTeMessagesStopped(ctx, ch, [
      { id: finalState.poll1_message_id, components: tePoll1Rows(flowId, true) },
      { id: finalState.poll2_message_id, components: tePoll2Rows(flowId, true) },
      { id: finalState.admin_message_id, components: teApprovalRows(flowId, true) },
    ], heading);
  }
  return true;
}

function scheduleTeAdminWait(
  ctx: BotContext,
  flowId: string,
  guildId: string,
  delayMs = ctx.config.TIMEOUT_EXTEND_ADMIN_WAIT_SECONDS * 1000,
): void {
  timeoutExtendOrchestrator.scheduleAdmin(ctx, flowId, guildId, delayMs);
}

async function listOpenTimeoutExtendFlows(ctx: BotContext): Promise<FlowRuntimeRow[]> {
  return ctx.db
    .selectFrom("polls")
    .select(["id", "guild_id", "status", "message_id", "state", "updated_at"])
    .where("kind", "=", TIMEOUT_EXTEND_FLOW_KIND)
    .where("status", "=", "open")
    .execute();
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
  await timeoutExtendOrchestrator.reconcile(ctx);
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

export async function beginTePoll1(ctx: BotContext, flowId: string, guildId: string, state: TimeoutExtendFlowState): Promise<boolean> {
  const ch = (await ctx.client.channels.fetch(state.channel_id).catch(() => null)) as TextChannel | null;
  if (!ch?.isTextBased()) {
    ctx.log.error({ flowId, phase: state.phase, guildId }, "timeoutExtend: vote channel unavailable");
    await abortTeFlow(ctx, flowId, state, "タイムアウト延長フロー: 投票チャンネルを取得できませんでした");
    return false;
  }

  const voteMs = ctx.config.EXEC_VOTE_SECONDS * 1000;
  const deadline = Date.now() + voteMs;
  const draft: TimeoutExtendFlowState = {
    ...state,
    poll1_deadline_ms: deadline,
    votes_poll1: {},
    phase: "poll1_pending",
    poll1_message_id: null,
    poll1_publish_reserved: true,
  };
  if (!await saveTeFullState(ctx, flowId, draft, null)) return false;

  const msg = await publishReservedPollMessage({
    store: new PollFlowStateStore(ctx.db),
    id: flowId,
    kind: TIMEOUT_EXTEND_FLOW_KIND,
    parse: parseTimeoutExtendFlowState,
    isReserved: (reserved) => reserved.phase === "poll1_pending"
      && reserved.poll1_publish_reserved === true
      && reserved.poll1_message_id === null
      && reserved.poll1_deadline_ms === deadline,
    publish: async (reserved) => {
      try {
        return await ch.send({
          ...componentCardsPayload([buildPoll1Embed(reserved, deadline)], tePoll1Rows(flowId, false)),
          allowedMentions: { users: [reserved.target_id] },
        });
      } catch (err) {
        ctx.log.error({ err, flowId, phase: state.phase, guildId }, "timeoutExtend: poll1 send failed");
        return null;
      }
    },
    publishedState: (reserved, message) => ({ ...reserved, poll1_message_id: message.id, poll1_publish_reserved: false }),
    messageId: (message) => message.id,
    discard: async (message) => { await message.delete().catch(() => undefined); },
  });
  if (!msg) {
    const reserved = await findOpenTimeoutExtendFlowById(ctx, flowId);
    if (reserved?.state.phase === "poll1_pending" && reserved.state.poll1_deadline_ms === deadline) {
      await abortTeFlow(ctx, flowId, reserved.state, "タイムアウト延長フロー: 投票メッセージの送信に失敗しました", guildId, reserved.row);
    }
    return false;
  }
  scheduleTePoll1Finalize(ctx, flowId, guildId, voteMs);
  return true;
}

async function resolveTimeoutExtendTransitionChannel(
  ctx: BotContext,
  flowId: string,
  guildId: string,
  state: TimeoutExtendFlowState,
): Promise<TextChannel | null> {
  const ch = (await ctx.client.channels.fetch(state.channel_id).catch(() => null)) as TextChannel | null;
  if (ch?.isTextBased()) return ch;
  ctx.log.error({ flowId, phase: state.phase, guildId }, "timeoutExtend: vote channel unavailable");
  await abortUnpublishedTimeoutExtendTransition(ctx, flowId, guildId, state.phase, "タイムアウト延長フロー: 投票チャンネルを取得できませんでした");
  return null;
}

async function disableTimeoutExtendPollMessage(
  channel: TextChannel,
  messageId: string | null,
  payload: ReturnType<typeof componentCardsPayload>,
): Promise<void> {
  if (!messageId) return;
  try {
    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (message) await message.edit(payload);
  } catch {
    /* UI の無効化失敗は状態確定を巻き戻さない */
  }
}

async function persistTimeoutExtendTransitionMessage(
  ctx: BotContext,
  flowId: string,
  pending: TimeoutExtendFlowState,
  published: TimeoutExtendFlowState,
  messageId: string | null,
): Promise<boolean> {
  const current = await new PollFlowStateStore(ctx.db).findOpen(flowId, TIMEOUT_EXTEND_FLOW_KIND, parseTimeoutExtendFlowState);
  if (!current || current.state.phase !== pending.phase) return false;
  return saveOpenPollState({
    store: new PollFlowStateStore(ctx.db),
    id: flowId,
    kind: TIMEOUT_EXTEND_FLOW_KIND,
    parse: parseTimeoutExtendFlowState,
    nextState: published,
    messageId,
    expected: { state: current.state, state_revision: current.stateRevision, rawState: current.rawState },
  });
}

async function abortUnpublishedTimeoutExtendTransition(
  ctx: BotContext,
  flowId: string,
  guildId: string,
  phase: TimeoutExtendFlowState["phase"],
  heading: string,
): Promise<void> {
  const current = await findOpenTimeoutExtendFlowById(ctx, flowId);
  if (!current || current.state.phase !== phase) return;
  await abortTeFlow(ctx, flowId, current.state, heading, guildId);
}

export async function transitionTePoll1ToNext(ctx: BotContext, flowId: string, guildId: string): Promise<void> {
  const found = await findOpenTimeoutExtendFlowById(ctx, flowId);
  if (!found || found.state.phase !== "poll1_pending") return;

  const { state } = found;

  const counts = tallyChoices(state.votes_poll1, [...TE_POLL1_KEYS]);
  const winner = pickSingleWinner(counts, [...TE_POLL1_KEYS]);
  if (winner == null) {
    await abortTeFlow(ctx, flowId, state, "タイムアウト延長フロー: 投票の最多票が確定しませんでした");
    return;
  }

  if (winner === "release") {
    const pending: TimeoutExtendFlowState = {
      ...state,
      phase: "admin_pending",
      resolved_extend: "release",
      duration_seconds: null,
      admin_message_id: null,
    };
    if (!await saveTeFullState(ctx, flowId, pending, null, found.row)) return;
    const ch = await resolveTimeoutExtendTransitionChannel(ctx, flowId, guildId, pending);
    if (!ch) return;
    await disableTimeoutExtendPollMessage(ch, state.poll1_message_id, componentCardsPayload([buildPoll1Embed(state, state.poll1_deadline_ms, true)], tePoll1Rows(flowId, true)));
    const adminMsg = await postTeAdminRequest(
      ctx,
      ch,
      flowId,
      `タイムアウト延長フロー — 最終承認: <@${state.target_id}> の **タイムアウト解除**`,
    );
    if (!adminMsg) {
      await abortUnpublishedTimeoutExtendTransition(ctx, flowId, guildId, pending.phase, "タイムアウト延長フロー: 最終承認メッセージの送信に失敗しました");
      return;
    }
    if (!await persistTimeoutExtendTransitionMessage(ctx, flowId, pending, { ...pending, admin_message_id: adminMsg.id }, null)) {
      await deleteTeFlowMessagesQuietly(ctx, ch, [adminMsg.id], "admin publication CAS lost");
      return;
    }
    scheduleTeAdminWait(ctx, flowId, guildId);
    return;
  }

  const voteMs = ctx.config.EXEC_VOTE_SECONDS * 1000;
  const deadline = Date.now() + voteMs;
  const pending: TimeoutExtendFlowState = {
    ...state,
    phase: "poll2_pending",
    poll2_message_id: null,
    poll2_deadline_ms: deadline,
    votes_poll2: {},
    resolved_extend: "extend",
  };
  if (!await saveTeFullState(ctx, flowId, pending, null, found.row)) return;
  const ch = await resolveTimeoutExtendTransitionChannel(ctx, flowId, guildId, pending);
  if (!ch) return;
  await disableTimeoutExtendPollMessage(ch, state.poll1_message_id, componentCardsPayload([buildPoll1Embed(state, state.poll1_deadline_ms, true)], tePoll1Rows(flowId, true)));

  let msg: Message;
  try {
    msg = await ch.send({
      ...componentCardsPayload([buildPoll2Embed(pending, deadline)], tePoll2Rows(flowId, false)),
      allowedMentions: { users: [state.target_id] },
    });
  } catch (err) {
    ctx.log.error({ err, flowId, phase: pending.phase, guildId }, "timeoutExtend: poll2 send failed");
    await abortUnpublishedTimeoutExtendTransition(ctx, flowId, guildId, pending.phase, "タイムアウト延長フロー: 延長時間投票の送信に失敗しました");
    return;
  }
  if (!await persistTimeoutExtendTransitionMessage(ctx, flowId, pending, { ...pending, poll2_message_id: msg.id }, msg.id)) {
    await deleteTeFlowMessagesQuietly(ctx, ch, [msg.id], "poll2 publication CAS lost");
    return;
  }
  scheduleTePoll2Finalize(ctx, flowId, guildId, voteMs);
}

export async function transitionTePoll2ToAdmin(ctx: BotContext, flowId: string, guildId: string): Promise<void> {
  const found = await findOpenTimeoutExtendFlowById(ctx, flowId);
  if (!found || found.state.phase !== "poll2_pending") return;

  const { state } = found;

  const counts = tallyChoices(state.votes_poll2, [...TE_POLL2_KEYS]);
  const winner = pickSingleWinner(counts, [...TE_POLL2_KEYS]);
  if (winner == null) {
    await abortTeFlow(ctx, flowId, state, "タイムアウト延長フロー: 延長時間の最多票が確定しませんでした");
    return;
  }

  const sec = TE_POLL2_SECONDS[winner as keyof typeof TE_POLL2_SECONDS];
  const durationSeconds = sec ?? 3600;
  const label = TE_POLL2_LABEL[winner as keyof typeof TE_POLL2_LABEL] ?? winner;

  const pending: TimeoutExtendFlowState = {
    ...state,
    phase: "admin_pending",
    resolved_extend: "extend",
    duration_seconds: durationSeconds,
    admin_message_id: null,
  };
  if (!await saveTeFullState(ctx, flowId, pending, null, found.row)) return;
  const ch = await resolveTimeoutExtendTransitionChannel(ctx, flowId, guildId, pending);
  if (!ch) return;
  await disableTimeoutExtendPollMessage(ch, state.poll2_message_id, componentCardsPayload([buildPoll2Embed(state, state.poll2_deadline_ms!, true)], tePoll2Rows(flowId, true)));
  const adminMsg = await postTeAdminRequest(
    ctx,
    ch,
    flowId,
    `タイムアウト延長フロー — 最終承認: <@${state.target_id}> の **タイムアウト延長（${label}）**`,
  );
  if (!adminMsg) {
    await abortUnpublishedTimeoutExtendTransition(ctx, flowId, guildId, pending.phase, "タイムアウト延長フロー: 最終承認メッセージの送信に失敗しました");
    return;
  }
  if (!await persistTimeoutExtendTransitionMessage(ctx, flowId, pending, { ...pending, admin_message_id: adminMsg.id }, null)) {
    await deleteTeFlowMessagesQuietly(ctx, ch, [adminMsg.id], "admin publication CAS lost");
    return;
  }
  scheduleTeAdminWait(ctx, flowId, guildId);
}

const timeoutExtendOrchestrator = new FlowOrchestrator<BotContext, TimeoutExtendFlowState>({
  namespace: "timeoutExtend",
  timers: timeoutExtendTimers,
  parse: (value) => parsePersistedFlowState(value, parseTimeoutExtendFlowState),
  targetId: (state) => state.target_id,
  clearTimers: clearTimeoutExtendTimers,
  retainTarget: retainTimeoutExtendTarget,
  releaseTarget: releaseTimeoutExtendTarget,
  releaseAllTargets: () => {
    for (const flowId of [...timeoutExtendFlowTargets.keys()]) releaseTimeoutExtendTarget(flowId);
  },
  listOpen: listOpenTimeoutExtendFlows,
  findOpen: async (ctx, flowId) => {
    const found = await findOpenTimeoutExtendFlowById(ctx, flowId);
    return found ? { row: found.row, state: found.state } : null;
  },
  cancelMalformed: cancelMalformedTimeoutExtendFlow,
  settleTerminal: async (ctx, row, state) => {
    await ctx.db.updateTable("polls").set({
      status: state.phase === "completed" ? "completed" : "cancelled",
      updated_at: sqliteTimestamp() as unknown as Date,
    }).where("id", "=", row.id).execute();
  },
  abort: async (ctx, flowId, state, heading, guildId) => abortTeFlow(ctx, flowId, state, heading, guildId),
  transitionPoll1: transitionTePoll1ToNext,
  transitionPoll2: transitionTePoll2ToAdmin,
  adminPending: (state) => state.phase === "admin_pending",
  adminDeadline: (ctx, row) => teAdminWaitDeadlineMs(row.updated_at, ctx.config.TIMEOUT_EXTEND_ADMIN_WAIT_SECONDS),
  claimed: (state) => state.phase === "admin_pending" && state.admin_button_fired,
  unpublished: (state) => (state.phase === "poll1_pending" && !state.poll1_message_id)
    || (state.phase === "poll2_pending" && !state.poll2_message_id)
    || (state.phase === "admin_pending" && !state.admin_message_id),
  poll1Deadline: (state) => state.phase === "poll1_pending" ? state.poll1_deadline_ms : null,
  poll2Deadline: (state) => state.phase === "poll2_pending" ? state.poll2_deadline_ms : null,
  restoredDeadlineExpiredHeading: "タイムアウト延長フロー: 再起動後の復元時に期限切れを検出",
  adminTimeoutHeading: "タイムアウト延長フロー: 承認がタイムアウトしました",
  duplicateTargetHeading: "タイムアウト延長フロー: 同一対象の重複フローを中止しました",
  claimedHeading: "タイムアウト延長フロー: 再起動後に未完了の承認処理を中止しました",
  unpublishedHeading: "タイムアウト延長フロー: 再起動後に未公開の遷移を中止しました",
  log: (ctx, level, fields, message) => ctx.log[level](fields, message),
});

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

  const flowId = randomUUID();
  if (!retainTimeoutExtendTarget(flowId, guild.id, targetUser.id)) {
    await interaction.editReply({ content: "この対象では既にタイムアウト延長フローが進行中です。" });
    return;
  }

  const baseState: TimeoutExtendFlowState = {
    phase: "poll1_pending",
    invoker_id: interaction.user.id,
    target_id: targetUser.id,
    channel_id: voteChannel.id,
    poll1_message_id: null,
    poll1_publish_reserved: false,
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

  try {
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
        state_revision: 0,
      })
      .execute();
  } catch (err) {
    releaseTimeoutExtendTarget(flowId);
    ctx.log.error({ err, flowId, guildId: guild.id, phase: baseState.phase }, "timeoutExtend: create flow failed");
    await interaction.editReply({ content: "フローの開始に失敗しました。" });
    return;
  }

  try {
    const started = await beginTePoll1(ctx, flowId, guild.id, baseState);
    if (!started) {
      releaseTimeoutExtendTarget(flowId);
      await interaction.editReply({ content: "投票チャンネルを取得できなかったため、フローを開始できませんでした。" });
      return;
    }
  } catch (err) {
    releaseTimeoutExtendTarget(flowId);
    await ctx.db.deleteFrom("polls").where("id", "=", flowId).execute().catch(() => undefined);
    ctx.log.error({ err, flowId, phase: baseState.phase, guildId: guild.id }, "timeoutExtend: begin failed");
    await interaction.editReply({ content: "フローの開始に失敗しました。" });
    return;
  }

  await interaction.editReply({
    content: `タイムアウト延長の投票を開始しました（投稿先: <#${voteChannel.id}>）。`,
  });
}

async function handleTeVote(interaction: ButtonInteraction, ctx: BotContext): Promise<boolean> {
  const parsed = parseTimeoutExtendVoteCustomId(interaction.customId);
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
    const next = await new PollFlowStateStore(ctx.db).mergeVoteWithRetry({
      id: flowId,
      kind: TIMEOUT_EXTEND_FLOW_KIND,
      expectedPhase: "poll1_pending",
      parse: parseTimeoutExtendFlowState,
      canMerge: (latest) => Date.now() <= latest.poll1_deadline_ms,
      merge: (latest) => ({ ...latest, votes_poll1: { ...latest.votes_poll1, [interaction.user.id]: choice } as TimeoutExtendFlowState["votes_poll1"] }),
      messageId: (latest) => latest.poll1_message_id,
    });
    if (!next) {
      await interaction.reply({ content: "投票状態が更新されたため、もう一度投票してください。", flags: MessageFlags.Ephemeral });
      return true;
    }

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
          ...componentCardsPayload([buildPoll1Embed(next, next.poll1_deadline_ms)], tePoll1Rows(flowId, false)),
        });
      } catch (err) {
        ctx.log.warn({ err, flowId, phase: state.phase, guildId: row.guild_id }, "timeoutExtend: poll1 edit failed");
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
    const next = await new PollFlowStateStore(ctx.db).mergeVoteWithRetry({
      id: flowId,
      kind: TIMEOUT_EXTEND_FLOW_KIND,
      expectedPhase: "poll2_pending",
      parse: parseTimeoutExtendFlowState,
      canMerge: (latest) => Boolean(latest.poll2_deadline_ms && Date.now() <= latest.poll2_deadline_ms),
      merge: (latest) => ({ ...latest, votes_poll2: { ...latest.votes_poll2, [interaction.user.id]: choice } as TimeoutExtendFlowState["votes_poll2"] }),
      messageId: (latest) => latest.poll2_message_id,
    });
    if (!next) {
      await interaction.reply({ content: "投票状態が更新されたため、もう一度投票してください。", flags: MessageFlags.Ephemeral });
      return true;
    }

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
          ...componentCardsPayload([buildPoll2Embed(next, next.poll2_deadline_ms!)], tePoll2Rows(flowId, false)),
        });
      } catch (err) {
        ctx.log.warn({ err, flowId, phase: state.phase, guildId: row.guild_id }, "timeoutExtend: poll2 edit failed");
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
  const parsed = parseTimeoutExtendApprovalCustomId(interaction.customId);
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

  const approverId = interaction.user.id;
  const textChannel = interaction.channel as TextChannel;

  const idsToDelete = [state.poll1_message_id, state.poll2_message_id, state.admin_message_id].filter((x): x is string => Boolean(x));

  const claim = await tryClaimTimeoutExtendApproval(ctx, row, state);
  if (!claim.ok) {
    await interaction.reply({ content: "状態の保存に失敗しました。再試行してください。", flags: MessageFlags.Ephemeral });
    return true;
  }
  if (!claim.claimed) {
    await interaction.reply({ content: "すでに処理済みです。", flags: MessageFlags.Ephemeral });
    return true;
  }

  if (action === "deny") {
    const committed = await commitClaimedTimeoutExtendTerminal(ctx, row, state, "cancelled");
    if (!committed) {
      await interaction.reply({ content: "状態の保存に失敗しました。再試行してください。", flags: MessageFlags.Ephemeral });
      return true;
    }
    await interaction.update({ components: teApprovalRows(flowId, true) }).catch(() => undefined);
    try {
      await textChannel.send({ content: "タイムアウト延長フローが非承認されたため、中止します。" });
    } catch (err) {
      ctx.log.warn({ err, flowId, phase: state.phase, guildId: row.guild_id }, "timeoutExtend: abort message failed");
    }
    await deleteTeFlowMessagesQuietly(ctx, textChannel, idsToDelete, "deny");
    ctx.log.info({ flowId, approverId, phase: state.phase, guildId: row.guild_id }, "timeoutExtend: final deny");
    return true;
  }

  const resolved = state.resolved_extend;
  if (resolved !== "extend" && resolved !== "release") {
    const committed = await commitClaimedTimeoutExtendTerminal(ctx, row, state, "cancelled");
    if (committed) await interaction.update({ components: teApprovalRows(flowId, true) }).catch(() => undefined);
    else await interaction.reply({ content: "状態の保存に失敗しました。再試行してください。", flags: MessageFlags.Ephemeral });
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
      ctx.log.warn({ err, flowId, phase: state.phase, guildId: row.guild_id }, "timeoutExtend: result message failed");
    }
  } else {
    try {
      await textChannel.send({ content: `タイムアウト処理の実行に失敗しました: ${result.message}` });
    } catch (err) {
      ctx.log.warn({ err, flowId, phase: state.phase, guildId: row.guild_id }, "timeoutExtend: error message failed");
    }
  }

  const committed = await commitClaimedTimeoutExtendTerminal(ctx, row, state, result.ok ? "completed" : "cancelled");
  if (!committed) {
    await interaction.reply({ content: "状態の保存に失敗しました。再試行してください。", flags: MessageFlags.Ephemeral });
    return true;
  }
  await interaction.update({ components: teApprovalRows(flowId, true) }).catch(() => undefined);
  await deleteTeFlowMessagesQuietly(ctx, textChannel, idsToDelete, "approve");

  ctx.log.info({ flowId, approverId, resolved, detailJa, ok: result.ok, phase: state.phase, guildId: row.guild_id }, "timeoutExtend: approved");
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

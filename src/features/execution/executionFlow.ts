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
import {
  buildExecutionAuditReason,
  clampTimeoutMs,
  discordVoteDeadlineEmbedLine,
  EXECUTION_FLOW_KIND,
  EXEC_APPROVAL_PREFIX,
  EXEC_VOTE_PREFIX,
  POLL1_KEYS,
  POLL1_LABEL,
  POLL2_CHOICE_TO_SECONDS,
  POLL2_KEYS,
  POLL2_LABEL,
} from "./executionConstants.js";
import type { ExecutionAction, ExecutionFlowState } from "./executionFlow.types.js";
import { parseExecutionFlowState } from "./executionFlow.types.js";
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
  tallyChoices,
  saveOpenPollState,
  claimPollAdminApproval,
  commitClaimedPollTerminal,
} from "./flowLifecycle.js";

const EXECUTION_LOCK_NAMESPACE = "execution";
const executionTimers = new FlowDeadlineTimers<ReturnType<typeof setTimeout>>({ setTimeout, clearTimeout });
const executionFlowTargets = new Map<string, { guildId: string; targetId: string }>();

type OpenExecutionFlowRow = {
  id: string;
  guild_id: string;
  status: string;
  message_id: string | null;
  state: unknown;
  state_revision: number;
  updated_at: Date;
};

function timerKey(phase: "poll1" | "poll2" | "admin", flowId: string): string {
  return `${phase}:${flowId}`;
}

function clearExecutionTimers(flowId: string): void {
  executionTimers.clear(timerKey("poll1", flowId));
  executionTimers.clear(timerKey("poll2", flowId));
  executionTimers.clear(timerKey("admin", flowId));
}

function retainExecutionTarget(flowId: string, guildId: string, targetId: string): boolean {
  const current = executionFlowTargets.get(flowId);
  if (current) return current.guildId === guildId && current.targetId === targetId;
  if (!flowTargetLocks.acquire(EXECUTION_LOCK_NAMESPACE, guildId, targetId)) return false;
  executionFlowTargets.set(flowId, { guildId, targetId });
  return true;
}

function releaseExecutionTarget(flowId: string): void {
  const target = executionFlowTargets.get(flowId);
  if (!target) return;
  flowTargetLocks.release(EXECUTION_LOCK_NAMESPACE, target.guildId, target.targetId);
  executionFlowTargets.delete(flowId);
}

/** プロセス終了時に、このランタイムが保持する処刑フローの期限タイマーと対象ロックを解放する。 */
export function shutdownExecutionFlowRuntime(): void {
  executionTimers.clearAll();
  for (const flowId of [...executionFlowTargets.keys()]) releaseExecutionTarget(flowId);
}

async function commitExecutionTerminal(
  ctx: BotContext,
  flowId: string,
  phase: string,
  persist: () => Promise<unknown>,
  fallbackGuildId?: string,
): Promise<boolean> {
  const guildId = executionFlowTargets.get(flowId)?.guildId ?? fallbackGuildId ?? "unknown";
  const result = await persistTerminalState(persist, () => {
    clearExecutionTimers(flowId);
    releaseExecutionTarget(flowId);
  });
  if (!result.ok) {
    ctx.log.error({ err: result.error, flowId, phase, guildId }, "execution: terminal state persistence failed");
  }
  return result.ok;
}

export async function claimExecutionApproval(ctx: BotContext, row: OpenExecutionFlowRow, state: ExecutionFlowState): Promise<boolean> {
  try {
    return await claimPollAdminApproval({
      store: new PollFlowStateStore(ctx.db), id: row.id, state, stateRevision: row.state_revision ?? 0, rawState: row.state,
    });
  } catch (err) {
    ctx.log.error({ err, flowId: row.id, phase: state.phase, guildId: row.guild_id }, "execution: approval claim failed");
    throw err;
  }
}

async function commitClaimedExecutionTerminal(
  ctx: BotContext,
  row: OpenExecutionFlowRow,
  state: ExecutionFlowState,
  terminalPhase: "completed" | "cancelled",
): Promise<boolean> {
  return commitExecutionTerminal(ctx, row.id, state.phase, async () => {
    const committed = await commitClaimedPollTerminal({
      store: new PollFlowStateStore(ctx.db), id: row.id, state, stateRevision: row.state_revision, terminalPhase,
    });
    if (!committed) throw new Error("execution flow terminal CAS lost");
  }, row.guild_id);
}

function schedulePoll1Finalize(ctx: BotContext, flowId: string, delayMs: number): void {
  executionOrchestrator.schedulePoll1(ctx, flowId, executionFlowTargets.get(flowId)?.guildId ?? "unknown", delayMs);
}

function schedulePoll2Finalize(ctx: BotContext, flowId: string, delayMs: number): void {
  executionOrchestrator.schedulePoll2(ctx, flowId, executionFlowTargets.get(flowId)?.guildId ?? "unknown", delayMs);
}

function adminWaitDeadlineMs(updatedAt: Date, waitSeconds: number): number {
  const updatedAtMs = new Date(updatedAt).getTime();
  const base = Number.isFinite(updatedAtMs) ? updatedAtMs : Date.now();
  return base + waitSeconds * 1000;
}

function memberHasRoleId(member: GuildMember, roleId: string): boolean {
  const id = roleId.trim();
  if (!id) return false;
  return member.roles.cache.has(id);
}

function parsePollRowState(row: { state: unknown }): ExecutionFlowState | null {
  return parsePersistedFlowState(row.state, parseExecutionFlowState);
}

export async function findOpenExecutionFlowById(
  ctx: BotContext,
  flowId: string,
): Promise<{ row: OpenExecutionFlowRow; state: ExecutionFlowState } | null> {
  const row = await ctx.db
    .selectFrom("polls")
    .select(["id", "guild_id", "status", "message_id", "state", "state_revision", "updated_at"])
    .where("id", "=", flowId)
    .where("kind", "=", EXECUTION_FLOW_KIND)
    .where("status", "=", "open")
    .executeTakeFirst();
  if (!row) return null;
  const stateRevision = normalizePollStateRevision(row.state_revision);
  if (stateRevision === null) {
    ctx.log.error({ flowId, guildId: row.guild_id, phase: "invalid_state_revision", stateRevision: row.state_revision }, "execution: ignoring unsafe flow state revision");
    return null;
  }
  const state = parsePollRowState(row);
  if (!state) return null;
  return { row: { ...row, state_revision: stateRevision }, state };
}

async function saveFullState(
  ctx: BotContext,
  flowId: string,
  state: ExecutionFlowState,
  messageId: string | null,
  expected?: OpenExecutionFlowRow,
): Promise<boolean> {
  return saveOpenPollState({
    store: new PollFlowStateStore(ctx.db),
    id: flowId,
    kind: EXECUTION_FLOW_KIND,
    parse: parseExecutionFlowState,
    nextState: state,
    messageId,
    ...(expected ? { expected: { state: parsePollRowState(expected) ?? state, state_revision: expected.state_revision, rawState: expected.state } } : {}),
  });
}

export async function deleteFlowMessagesQuietly(
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
      ctx.log.warn({ err, id, logLabel }, "execution: delete flow message failed");
    }
  }
}

export function parseExecutionVoteCustomId(customId: string): { flowId: string; choice: string } | null {
  if (!customId.startsWith(EXEC_VOTE_PREFIX)) return null;
  const rest = customId.slice(EXEC_VOTE_PREFIX.length);
  const idx = rest.lastIndexOf(":");
  if (idx <= 0) return null;
  return { flowId: rest.slice(0, idx), choice: rest.slice(idx + 1) };
}

export function parseExecutionApprovalCustomId(customId: string): { flowId: string; action: "approve" | "deny" } | null {
  if (!customId.startsWith(EXEC_APPROVAL_PREFIX)) return null;
  const rest = customId.slice(EXEC_APPROVAL_PREFIX.length);
  const idx = rest.lastIndexOf(":");
  if (idx <= 0) return null;
  const action = rest.slice(idx + 1);
  if (action !== "approve" && action !== "deny") return null;
  return { flowId: rest.slice(0, idx), action };
}

function choiceToAction1(c: string): ExecutionAction | null {
  if (c === "1") return "timeout";
  if (c === "2") return "kick";
  if (c === "3") return "ban";
  return null;
}

/** 処刑フロー第1投票（処刑内容）。`pollEnded` 後は `:R` を使わず増加表示を防ぐ */
function buildPoll1Embed(state: ExecutionFlowState, poll1DeadlineMs: number, pollEnded = false): ComponentCardBuilder {
  const counts = tallyChoices(state.votes_poll1, POLL1_KEYS);
  const lines = POLL1_KEYS.map((k) => `**${k}.** ${POLL1_LABEL[k]} — ${counts[k] ?? 0} 票`);
  return new ComponentCardBuilder()
    .setTitle("処刑内容の投票")
    .setDescription(
      [
        `対象: <@${state.target_id}>`,
        "",
        "**投票先（ボタン 1〜3）**",
        ...lines,
        "",
        discordVoteDeadlineEmbedLine(poll1DeadlineMs, pollEnded),
      ].join("\n"),
    )
    .setTimestamp(new Date());
}

/** 処刑フロー第2投票（タイムアウト時間） */
function buildPoll2Embed(state: ExecutionFlowState, poll2DeadlineMs: number, pollEnded = false): ComponentCardBuilder {
  const counts = tallyChoices(state.votes_poll2, POLL2_KEYS);
  const lines = POLL2_KEYS.map((k) => `**${k}.** ${POLL2_LABEL[k]} — ${counts[k] ?? 0} 票`);
  return new ComponentCardBuilder()
    .setTitle("タイムアウト時間の投票")
    .setDescription(
      [
        `対象: <@${state.target_id}>`,
        "",
        "**投票先（ボタン 1〜4）**",
        ...lines,
        "",
        discordVoteDeadlineEmbedLine(poll2DeadlineMs, pollEnded),
      ].join("\n"),
    )
    .setTimestamp(new Date());
}

function poll1Rows(flowId: string, disabled: boolean): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...POLL1_KEYS.map((k) =>
      new ButtonBuilder()
        .setCustomId(`${EXEC_VOTE_PREFIX}${flowId}:${k}`)
        .setLabel(k)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
    ),
  );
  return [row];
}

function poll2Rows(flowId: string, disabled: boolean): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...POLL2_KEYS.map((k) =>
      new ButtonBuilder()
        .setCustomId(`${EXEC_VOTE_PREFIX}${flowId}:${k}`)
        .setLabel(k)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
    ),
  );
  return [row];
}

function approvalRows(flowId: string, disabled: boolean): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${EXEC_APPROVAL_PREFIX}${flowId}:approve`)
        .setLabel("承認")
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`${EXEC_APPROVAL_PREFIX}${flowId}:deny`)
        .setLabel("非承認")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled),
    ),
  ];
}

async function editMessagesStopped(
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
      ctx.log.warn({ err, mid }, "execution: edit stopped message failed");
    }
  }
}

export async function abortFlow(
  ctx: BotContext,
  flowId: string,
  state: ExecutionFlowState,
  heading: string,
  guildId?: string,
  expected?: OpenExecutionFlowRow,
): Promise<boolean> {
  let committedState: ExecutionFlowState | null = null;
  const committed = await commitExecutionTerminal(ctx, flowId, state.phase, async () => {
    const current = await new PollFlowStateStore(ctx.db).cancelOpenFlow({
      id: flowId,
      kind: EXECUTION_FLOW_KIND,
      expectedPhase: state.phase,
      parse: parseExecutionFlowState,
      ...(expected ? { expected: { state, stateRevision: expected.state_revision, rawState: expected.state } } : {}),
      canCancel: (currentState) => currentState.admin_button_fired === false,
    });
    if (!current) throw new Error("execution flow terminal CAS lost");
    committedState = current;
  }, guildId);
  if (!committed) return false;
  const finalState = committedState ?? state;
  const ch = (await ctx.client.channels.fetch(finalState.channel_id).catch(() => null)) as TextChannel | null;
  if (ch?.isTextBased()) {
    await editMessagesStopped(ctx, ch, [
      { id: finalState.precheck_message_id, components: approvalRows(flowId, true) },
      { id: finalState.poll1_message_id, components: poll1Rows(flowId, true) },
      { id: finalState.poll2_message_id, components: poll2Rows(flowId, true) },
      { id: finalState.admin_message_id, components: approvalRows(flowId, true) },
    ], heading);
  }
  return true;
}

function scheduleAdminWait(
  ctx: BotContext,
  flowId: string,
  expectedPhase: "precheck_pending" | "admin_pending",
  delayMs = ctx.config.EXEC_ADMIN_WAIT_SECONDS * 1000,
): void {
  void expectedPhase;
  executionOrchestrator.scheduleAdmin(ctx, flowId, executionFlowTargets.get(flowId)?.guildId ?? "unknown", delayMs);
}

async function listOpenExecutionFlows(ctx: BotContext): Promise<FlowRuntimeRow[]> {
  return ctx.db
    .selectFrom("polls")
    .select(["id", "guild_id", "status", "message_id", "state", "updated_at"])
    .where("kind", "=", EXECUTION_FLOW_KIND)
    .where("status", "=", "open")
    .execute();
}

async function cancelMalformedExecutionFlow(ctx: BotContext, flowId: string): Promise<void> {
  await ctx.db
    .updateTable("polls")
    .set({
      status: "cancelled",
      updated_at: sqliteTimestamp() as unknown as Date,
    })
    .where("id", "=", flowId)
    .execute();
}

export async function reconcileExecutionFlows(ctx: BotContext): Promise<void> {
  await executionOrchestrator.reconcile(ctx);
}

async function postPrecheckRequest(ctx: BotContext, channel: TextChannel, flowId: string): Promise<Message | null> {
  const adminRoleId = ctx.config.ADMIN_ROLE_ID.trim();
  try {
    return await channel.send({
      content: `<@&${adminRoleId}> 対象に処刑者ロールがありません。続行するには管理者の承認が必要です。`,
      components: approvalRows(flowId, false),
      allowedMentions: { roles: [adminRoleId] },
    });
  } catch (err) {
    ctx.log.warn({ err, flowId }, "execution: precheck send failed");
    return null;
  }
}

async function postAdminRequest(ctx: BotContext, channel: TextChannel, flowId: string, body: string): Promise<Message | null> {
  const adminRoleId = ctx.config.ADMIN_ROLE_ID.trim();
  try {
    return await channel.send({
      content: `${body}\n<@&${adminRoleId}>`,
      components: approvalRows(flowId, false),
      allowedMentions: { roles: [adminRoleId] },
    });
  } catch (err) {
    ctx.log.warn({ err, flowId }, "execution: admin request send failed");
    return null;
  }
}

export async function beginPoll1(ctx: BotContext, flowId: string, state: ExecutionFlowState): Promise<boolean> {
  const ch = (await ctx.client.channels.fetch(state.channel_id).catch(() => null)) as TextChannel | null;
  if (!ch?.isTextBased()) {
    ctx.log.error(
      { flowId, phase: state.phase, guildId: executionFlowTargets.get(flowId)?.guildId ?? "unknown" },
      "execution: vote channel unavailable",
    );
    await abortFlow(ctx, flowId, state, "処刑フロー: 投票チャンネルを取得できませんでした");
    return false;
  }

  const voteMs = ctx.config.EXEC_VOTE_SECONDS * 1000;
  const deadline = Date.now() + voteMs;
  const pending: ExecutionFlowState = {
    ...state,
    phase: "poll1_pending",
    poll1_message_id: null,
    poll1_deadline_ms: deadline,
    votes_poll1: {},
  };
  if (!await saveFullState(ctx, flowId, pending, null)) return false;

  const msg = await publishReservedPollMessage({
    store: new PollFlowStateStore(ctx.db),
    id: flowId,
    kind: EXECUTION_FLOW_KIND,
    parse: parseExecutionFlowState,
    isReserved: (reserved) => reserved.phase === "poll1_pending" && reserved.poll1_deadline_ms === deadline && reserved.poll1_message_id === null,
    publish: async (reserved) => {
      try {
        return await ch.send({
          ...componentCardsPayload([buildPoll1Embed(reserved, deadline)], poll1Rows(flowId, false)),
          allowedMentions: { users: [reserved.target_id] },
        });
      } catch (err) {
        ctx.log.error({ err, flowId, phase: state.phase, guildId: executionFlowTargets.get(flowId)?.guildId ?? "unknown" }, "execution: poll1 send failed");
        return null;
      }
    },
    publishedState: (reserved, message) => ({ ...reserved, poll1_message_id: message.id }),
    messageId: (message) => message.id,
    discard: async (message) => { await message.delete().catch(() => undefined); },
  });
  if (!msg) {
    const persisted = await findOpenExecutionFlowById(ctx, flowId);
    if (persisted?.state.phase === "poll1_pending" && persisted.state.poll1_deadline_ms === deadline) {
      await abortFlow(ctx, flowId, persisted.state, "処刑フロー: 投票メッセージの送信に失敗しました", persisted.row.guild_id, persisted.row);
    }
    return false;
  }
  schedulePoll1Finalize(ctx, flowId, voteMs);
  return true;
}

/** 初回の事前承認投稿は、Discord APIの副作用より先にCAS予約を確定する。 */
export async function beginInitialPrecheck(
  ctx: BotContext,
  flowId: string,
  guildId: string,
  state: ExecutionFlowState,
  channel: TextChannel,
): Promise<boolean> {
  const reservedState: ExecutionFlowState = {
    ...state,
    phase: "precheck_pending",
    precheck_message_id: null,
    precheck_publish_reserved: true,
  };
  if (!await saveFullState(ctx, flowId, reservedState, null)) return false;

  const reserved = await findOpenExecutionFlowById(ctx, flowId);
  if (!reserved
    || reserved.state.phase !== "precheck_pending"
    || !reserved.state.precheck_publish_reserved
    || reserved.state.precheck_message_id !== null) return false;

  const message = await postPrecheckRequest(ctx, channel, flowId);
  if (!message) {
    await abortFlow(ctx, flowId, reserved.state, "処刑フロー: 事前承認メッセージの送信に失敗しました", guildId, reserved.row);
    return false;
  }

  const next: ExecutionFlowState = {
    ...reserved.state,
    precheck_message_id: message.id,
    precheck_publish_reserved: false,
  };
  if (!await saveFullState(ctx, flowId, next, null, reserved.row)) {
    await message.delete().catch(() => undefined);
    return false;
  }
  return true;
}

async function resolveExecutionTransitionChannel(
  ctx: BotContext,
  flowId: string,
  state: ExecutionFlowState,
): Promise<TextChannel | null> {
  const ch = (await ctx.client.channels.fetch(state.channel_id).catch(() => null)) as TextChannel | null;
  if (ch?.isTextBased()) return ch;
  ctx.log.error(
    { flowId, phase: state.phase, guildId: executionFlowTargets.get(flowId)?.guildId ?? "unknown" },
    "execution: vote channel unavailable",
  );
  await abortUnpublishedExecutionTransition(ctx, flowId, state.phase, "処刑フロー: 投票チャンネルを取得できませんでした");
  return null;
}

async function disableExecutionPollMessage(
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

async function persistExecutionTransitionMessage(
  ctx: BotContext,
  flowId: string,
  pending: ExecutionFlowState,
  published: ExecutionFlowState,
  messageId: string | null,
): Promise<boolean> {
  const current = await new PollFlowStateStore(ctx.db).findOpen(flowId, EXECUTION_FLOW_KIND, parseExecutionFlowState);
  if (!current || current.state.phase !== pending.phase) return false;
  return saveOpenPollState({
    store: new PollFlowStateStore(ctx.db),
    id: flowId,
    kind: EXECUTION_FLOW_KIND,
    parse: parseExecutionFlowState,
    nextState: published,
    messageId,
    expected: { state: current.state, state_revision: current.stateRevision, rawState: current.rawState },
  });
}

async function abortUnpublishedExecutionTransition(
  ctx: BotContext,
  flowId: string,
  phase: ExecutionFlowState["phase"],
  heading: string,
): Promise<void> {
  const current = await findOpenExecutionFlowById(ctx, flowId);
  if (!current || current.state.phase !== phase) return;
  await abortFlow(ctx, flowId, current.state, heading, current.row.guild_id);
}

export async function transitionPoll1ToNext(ctx: BotContext, flowId: string): Promise<void> {
  const found = await findOpenExecutionFlowById(ctx, flowId);
  if (!found || found.state.phase !== "poll1_pending") return;

  const { state } = found;

  const counts = tallyChoices(state.votes_poll1, POLL1_KEYS);
  const winner = pickSingleWinner(counts, [...POLL1_KEYS]);
  if (winner == null) {
    await abortFlow(ctx, flowId, state, "処刑フロー: 投票の最多票が確定しませんでした");
    return;
  }

  const action = choiceToAction1(winner);
  if (!action) return;

  if (action === "timeout") {
    const voteMs = ctx.config.EXEC_VOTE_SECONDS * 1000;
    const deadline = Date.now() + voteMs;
    const pending: ExecutionFlowState = {
      ...state,
      phase: "poll2_pending",
      resolved_action: "timeout",
      poll2_message_id: null,
      poll2_deadline_ms: deadline,
      votes_poll2: {},
    };
    if (!await saveFullState(ctx, flowId, pending, null, found.row)) return;

    const ch = await resolveExecutionTransitionChannel(ctx, flowId, pending);
    if (!ch) return;
    await disableExecutionPollMessage(ch, state.poll1_message_id, componentCardsPayload([buildPoll1Embed(state, state.poll1_deadline_ms, true)], poll1Rows(flowId, true)));

    let msg: Message;
    try {
      msg = await ch.send({
        ...componentCardsPayload([buildPoll2Embed(pending, deadline)], poll2Rows(flowId, false)),
        allowedMentions: { users: [state.target_id] },
      });
    } catch (err) {
      ctx.log.error({ err, flowId, phase: pending.phase, guildId: executionFlowTargets.get(flowId)?.guildId ?? "unknown" }, "execution: poll2 send failed");
      await abortUnpublishedExecutionTransition(ctx, flowId, pending.phase, "処刑フロー: タイムアウト時間投票の送信に失敗しました");
      return;
    }
    if (!await persistExecutionTransitionMessage(ctx, flowId, pending, { ...pending, poll2_message_id: msg.id }, msg.id)) {
      await deleteFlowMessagesQuietly(ctx, ch, [msg.id], "poll2 publication CAS lost");
      return;
    }
    schedulePoll2Finalize(ctx, flowId, voteMs);
    return;
  }

  const pending: ExecutionFlowState = {
    ...state,
    phase: "admin_pending",
    resolved_action: action,
    duration_seconds: null,
    admin_message_id: null,
  };
  if (!await saveFullState(ctx, flowId, pending, null, found.row)) return;
  const ch = await resolveExecutionTransitionChannel(ctx, flowId, pending);
  if (!ch) return;
  await disableExecutionPollMessage(ch, state.poll1_message_id, componentCardsPayload([buildPoll1Embed(state, state.poll1_deadline_ms, true)], poll1Rows(flowId, true)));
  const targetName = `<@${state.target_id}>`;
  const detail = action === "kick" ? "キック" : "BAN";
  const adminMsg = await postAdminRequest(
    ctx,
    ch,
    flowId,
    `処刑の最終承認: ${targetName} → ${detail}`,
  );
  if (!adminMsg) {
    await abortUnpublishedExecutionTransition(ctx, flowId, pending.phase, "処刑フロー: 最終承認メッセージの送信に失敗しました");
    return;
  }
  if (!await persistExecutionTransitionMessage(ctx, flowId, pending, { ...pending, admin_message_id: adminMsg.id }, null)) {
    await deleteFlowMessagesQuietly(ctx, ch, [adminMsg.id], "admin publication CAS lost");
    return;
  }
  scheduleAdminWait(ctx, flowId, "admin_pending");
}

export async function transitionPoll2ToAdmin(ctx: BotContext, flowId: string): Promise<void> {
  const found = await findOpenExecutionFlowById(ctx, flowId);
  if (!found || found.state.phase !== "poll2_pending") return;

  const { state } = found;

  const counts = tallyChoices(state.votes_poll2, POLL2_KEYS);
  const winner = pickSingleWinner(counts, [...POLL2_KEYS]);
  if (winner == null) {
    await abortFlow(ctx, flowId, state, "処刑フロー: タイムアウト時間の最多票が確定しませんでした");
    return;
  }

  const sec = POLL2_CHOICE_TO_SECONDS[winner as keyof typeof POLL2_CHOICE_TO_SECONDS];
  const durationSeconds = sec ?? 60;
  const label = POLL2_LABEL[winner as keyof typeof POLL2_LABEL] ?? winner;

  const pending: ExecutionFlowState = {
    ...state,
    phase: "admin_pending",
    resolved_action: "timeout",
    duration_seconds: durationSeconds,
    admin_message_id: null,
  };
  if (!await saveFullState(ctx, flowId, pending, null, found.row)) return;
  const ch = await resolveExecutionTransitionChannel(ctx, flowId, pending);
  if (!ch) return;
  await disableExecutionPollMessage(ch, state.poll2_message_id, componentCardsPayload([buildPoll2Embed(state, state.poll2_deadline_ms!, true)], poll2Rows(flowId, true)));
  const adminMsg = await postAdminRequest(
    ctx,
    ch,
    flowId,
    `処刑の最終承認: <@${state.target_id}> → タイムアウト（${label}）`,
  );
  if (!adminMsg) {
    await abortUnpublishedExecutionTransition(ctx, flowId, pending.phase, "処刑フロー: 最終承認メッセージの送信に失敗しました");
    return;
  }
  if (!await persistExecutionTransitionMessage(ctx, flowId, pending, { ...pending, admin_message_id: adminMsg.id }, null)) {
    await deleteFlowMessagesQuietly(ctx, ch, [adminMsg.id], "admin publication CAS lost");
    return;
  }
  scheduleAdminWait(ctx, flowId, "admin_pending");
}

const executionOrchestrator = new FlowOrchestrator<BotContext, ExecutionFlowState>({
  namespace: "execution",
  timers: executionTimers,
  parse: (value) => parsePersistedFlowState(value, parseExecutionFlowState),
  targetId: (state) => state.target_id,
  clearTimers: clearExecutionTimers,
  retainTarget: retainExecutionTarget,
  releaseTarget: releaseExecutionTarget,
  releaseAllTargets: () => {
    for (const flowId of [...executionFlowTargets.keys()]) releaseExecutionTarget(flowId);
  },
  listOpen: listOpenExecutionFlows,
  findOpen: async (ctx, flowId) => {
    const found = await findOpenExecutionFlowById(ctx, flowId);
    return found ? { row: found.row, state: found.state } : null;
  },
  cancelMalformed: cancelMalformedExecutionFlow,
  settleTerminal: async (ctx, row, state) => {
    await ctx.db.updateTable("polls").set({
      status: state.phase === "completed" ? "completed" : "cancelled",
      updated_at: sqliteTimestamp() as unknown as Date,
    }).where("id", "=", row.id).execute();
  },
  abort: async (ctx, flowId, state, heading, guildId) => abortFlow(ctx, flowId, state, heading, guildId),
  transitionPoll1: async (ctx, flowId) => transitionPoll1ToNext(ctx, flowId),
  transitionPoll2: async (ctx, flowId) => transitionPoll2ToAdmin(ctx, flowId),
  adminPending: (state) => state.phase === "precheck_pending" || state.phase === "admin_pending",
  adminDeadline: (ctx, row) => adminWaitDeadlineMs(row.updated_at, ctx.config.EXEC_ADMIN_WAIT_SECONDS),
  claimed: (state) => state.phase === "admin_pending" && state.admin_button_fired,
  unpublished: (state) => (state.phase === "poll1_pending" && !state.poll1_message_id)
    || (state.phase === "poll2_pending" && !state.poll2_message_id)
    || (state.phase === "admin_pending" && !state.admin_message_id),
  poll1Deadline: (state) => state.phase === "poll1_pending" ? state.poll1_deadline_ms : null,
  poll2Deadline: (state) => state.phase === "poll2_pending" ? state.poll2_deadline_ms : null,
  restoredDeadlineExpiredHeading: "処刑フロー: 再起動後の復元時に期限切れを検出",
  adminTimeoutHeading: "処刑フロー: 承認がタイムアウトしました",
  duplicateTargetHeading: "処刑フロー: 同一対象の重複フローを中止しました",
  claimedHeading: "処刑フロー: 再起動後に未完了の承認処理を中止しました",
  unpublishedHeading: "処刑フロー: 再起動後に未公開の遷移を中止しました",
  log: (ctx, level, fields, message) => ctx.log[level](fields, message),
});

export async function startExecutionFlow(
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

  if (isAdmin(targetMember, ctx.config)) {
    const ch = interaction.channel;
    if (ch?.isTextBased() && !ch.isDMBased()) {
      await (ch as TextChannel).send({
        content: `<@${interaction.user.id}> が <@${targetUser.id}> に対し、処刑しようとしました`,
        allowedMentions: { users: [interaction.user.id, targetUser.id] },
      });
    }
    await interaction.editReply({ content: "記録しました。" });
    return;
  }

  const channel = interaction.channel;
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    await interaction.editReply({ content: "このチャンネルでは実行できません。" });
    return;
  }
  const textChannel = channel as TextChannel;

  const flowId = randomUUID();
  if (!retainExecutionTarget(flowId, guild.id, targetUser.id)) {
    await interaction.editReply({ content: "この対象では既に処刑フローが進行中です。" });
    return;
  }
  const executorRole = ctx.config.EXECUTOR_ROLE_ID?.trim();
  const needsPrecheck = Boolean(executorRole && !memberHasRoleId(targetMember, executorRole));

  const baseState: ExecutionFlowState = {
    phase: needsPrecheck ? "precheck_pending" : "poll1_pending",
    invoker_id: interaction.user.id,
    target_id: targetUser.id,
    channel_id: textChannel.id,
    precheck_message_id: null,
    precheck_publish_reserved: false,
    poll1_message_id: null,
    poll2_message_id: null,
    votes_poll1: {},
    votes_poll2: {},
    poll1_deadline_ms: 0,
    poll2_deadline_ms: null,
    admin_message_id: null,
    resolved_action: null,
    duration_seconds: null,
    admin_button_fired: false,
  };

  try {
    await ctx.db
      .insertInto("polls")
      .values({
        id: flowId,
        guild_id: guild.id,
        channel_id: textChannel.id,
        message_id: null,
        kind: EXECUTION_FLOW_KIND,
        status: "open",
        state: JSON.stringify(baseState) as unknown as Record<string, unknown>,
        ends_at: null,
        created_at: sqliteTimestamp() as unknown as Date,
        updated_at: sqliteTimestamp() as unknown as Date,
        state_revision: 0,
      })
      .execute();
  } catch (err) {
    releaseExecutionTarget(flowId);
    ctx.log.error({ err, flowId, phase: baseState.phase, guildId: guild.id }, "execution: create flow failed");
    await interaction.editReply({ content: "フローの開始に失敗しました。" });
    return;
  }

  if (needsPrecheck) {
    const published = await beginInitialPrecheck(ctx, flowId, guild.id, baseState, textChannel);
    if (!published) {
      releaseExecutionTarget(flowId);
      await interaction.editReply({ content: "事前承認メッセージを投稿できなかったため、フローを開始できませんでした。" });
      return;
    }
    scheduleAdminWait(ctx, flowId, "precheck_pending");
    await interaction.editReply({ content: "管理者の事前承認を待っています。" });
    return;
  }

  try {
    const started = await beginPoll1(ctx, flowId, baseState);
    if (!started) {
      await interaction.editReply({ content: "投票チャンネルを取得できなかったため、フローを開始できませんでした。" });
      return;
    }
  } catch (err) {
    releaseExecutionTarget(flowId);
    await ctx.db.deleteFrom("polls").where("id", "=", flowId).execute().catch(() => undefined);
    ctx.log.error({ err, flowId, phase: baseState.phase, guildId: guild.id }, "execution: begin failed");
    await interaction.editReply({ content: "フローの開始に失敗しました。" });
    return;
  }
  await interaction.editReply({ content: "処刑投票を開始しました。" });
}

async function handleVote(interaction: ButtonInteraction, ctx: BotContext): Promise<boolean> {
  const parsed = parseExecutionVoteCustomId(interaction.customId);
  if (!parsed) return false;

  if (interaction.user.bot) {
    await interaction.reply({ content: "BOT は投票できません。", flags: MessageFlags.Ephemeral });
    return true;
  }

  const { flowId, choice } = parsed;
  const found = await findOpenExecutionFlowById(ctx, flowId);
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
    if (!POLL1_KEYS.includes(choice as (typeof POLL1_KEYS)[number])) {
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
      kind: EXECUTION_FLOW_KIND,
      expectedPhase: "poll1_pending",
      parse: parseExecutionFlowState,
      canMerge: (latest) => Date.now() <= latest.poll1_deadline_ms,
      merge: (latest) => ({ ...latest, votes_poll1: { ...latest.votes_poll1, [interaction.user.id]: choice } as ExecutionFlowState["votes_poll1"] }),
      messageId: (latest) => latest.poll1_message_id,
    });
    if (!next) {
      await interaction.reply({ content: "投票状態が更新されたため、もう一度投票してください。", flags: MessageFlags.Ephemeral });
      return true;
    }

    const label = POLL1_LABEL[choice as keyof typeof POLL1_LABEL];
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
        await m.edit(componentCardsPayload([buildPoll1Embed(next, next.poll1_deadline_ms)], poll1Rows(flowId, false)));
      } catch (err) {
        ctx.log.warn({ err, flowId, phase: state.phase, guildId: row.guild_id }, "execution: poll1 edit failed");
      }
    }
    return true;
  }

  if (state.phase === "poll2_pending") {
    if (!POLL2_KEYS.includes(choice as (typeof POLL2_KEYS)[number])) {
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
      kind: EXECUTION_FLOW_KIND,
      expectedPhase: "poll2_pending",
      parse: parseExecutionFlowState,
      canMerge: (latest) => Boolean(latest.poll2_deadline_ms && Date.now() <= latest.poll2_deadline_ms),
      merge: (latest) => ({ ...latest, votes_poll2: { ...latest.votes_poll2, [interaction.user.id]: choice } as ExecutionFlowState["votes_poll2"] }),
      messageId: (latest) => latest.poll2_message_id,
    });
    if (!next) {
      await interaction.reply({ content: "投票状態が更新されたため、もう一度投票してください。", flags: MessageFlags.Ephemeral });
      return true;
    }

    const label = POLL2_LABEL[choice as keyof typeof POLL2_LABEL];
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
        await m.edit(componentCardsPayload([buildPoll2Embed(next, next.poll2_deadline_ms!)], poll2Rows(flowId, false)));
      } catch (err) {
        ctx.log.warn({ err, flowId, phase: state.phase, guildId: row.guild_id }, "execution: poll2 edit failed");
      }
    }
    return true;
  }

  await interaction.reply({ content: "この投票は終了しています。", flags: MessageFlags.Ephemeral });
  return true;
}

function actionLabelJa(action: ExecutionAction): string {
  if (action === "timeout") return "タイムアウト";
  if (action === "kick") return "キック";
  return "BAN";
}

function durationLabelFromSeconds(sec: number | null): string {
  if (sec == null) return "";
  if (sec < 120) return `${sec}秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)}分`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}時間`;
  if (sec < 86400 * 7) return `${Math.floor(sec / 86400)}日`;
  return `${Math.floor(sec / (86400 * 7))}週間`;
}

/** 監査・キック/BAN/タイムアウト理由・Detecter 通知に渡す日本語の処罰内容（BOT が自動生成） */
function buildPunishmentDetailJa(state: ExecutionFlowState): string {
  const act = state.resolved_action;
  if (!act) return "処罰";
  if (act === "timeout") {
    const sec = state.duration_seconds;
    if (sec == null) return "タイムアウト";
    return `タイムアウト（${durationLabelFromSeconds(sec)}）`;
  }
  if (act === "kick") return "キック";
  return "BAN";
}

async function carryOutPunishment(
  guild: Guild,
  targetId: string,
  action: ExecutionAction,
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
    if (action === "timeout") {
      const sec = durationSeconds ?? 60;
      const ms = clampTimeoutMs(sec * 1000);
      await member.timeout(ms, reason);
    } else if (action === "kick") {
      await member.kick(reason);
    } else {
      await member.ban({ reason, deleteMessageSeconds: 0 });
    }
    return { ok: true };
  } catch (err) {
    ctx.log.warn({ err, targetId, action }, "execution: punishment failed");
    if (err instanceof DiscordAPIError) {
      return { ok: false, message: `Discord API: ${err.message}` };
    }
    return { ok: false, message: String(err) };
  }
}

async function handleApproval(interaction: ButtonInteraction, ctx: BotContext): Promise<boolean> {
  const parsed = parseExecutionApprovalCustomId(interaction.customId);
  if (!parsed) return false;

  const { flowId, action } = parsed;
  const found = await findOpenExecutionFlowById(ctx, flowId);
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

  if (state.phase === "precheck_pending") {
    if (action === "deny") {
      const committed = await abortFlow(ctx, flowId, state, "処刑フロー: 事前承認が拒否されました");
      if (!committed) {
        await interaction.reply({ content: "状態の保存に失敗しました。再試行してください。", flags: MessageFlags.Ephemeral });
        return true;
      }
      await interaction.update({ components: approvalRows(flowId, true) }).catch(() => undefined);
      return true;
    }
    const next: ExecutionFlowState = { ...state, phase: "poll1_pending", precheck_message_id: state.precheck_message_id };
    try {
      const saved = await saveFullState(ctx, flowId, next, null, row);
      if (!saved) {
        await interaction.reply({ content: "このフローは既に処理されています。再試行してください。", flags: MessageFlags.Ephemeral });
        return true;
      }
    } catch (err) {
      ctx.log.error({ err, flowId, phase: state.phase, guildId: row.guild_id }, "execution: precheck approval persistence failed");
      await interaction.reply({ content: "状態の保存に失敗しました。再試行してください。", flags: MessageFlags.Ephemeral });
      return true;
    }
    executionTimers.clear(timerKey("admin", flowId));
    await interaction.update({ components: approvalRows(flowId, true) }).catch(() => undefined);
    await beginPoll1(ctx, flowId, next);
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

  const idsToDelete = [state.precheck_message_id, state.poll1_message_id, state.poll2_message_id, state.admin_message_id].filter(
    (x): x is string => Boolean(x),
  );

  let claimed: boolean;
  try {
    claimed = await claimExecutionApproval(ctx, row, state);
  } catch {
    await interaction.reply({ content: "状態の保存に失敗しました。再試行してください。", flags: MessageFlags.Ephemeral });
    return true;
  }
  if (!claimed) {
    await interaction.reply({ content: "すでに処理済みです。", flags: MessageFlags.Ephemeral });
    return true;
  }

  if (action === "deny") {
    const committed = await commitClaimedExecutionTerminal(ctx, row, state, "cancelled");
    if (!committed) {
      await interaction.reply({ content: "状態の保存に失敗しました。再試行してください。", flags: MessageFlags.Ephemeral });
      return true;
    }
    await interaction.update({ components: approvalRows(flowId, true) }).catch(() => undefined);
    try {
      await textChannel.send({ content: "処刑が非承認されたため、中止します" });
    } catch (err) {
      ctx.log.warn({ err, flowId, phase: state.phase, guildId: row.guild_id }, "execution: abort message failed");
    }
    await deleteFlowMessagesQuietly(ctx, textChannel, idsToDelete, "reject");
    ctx.log.info({ flowId, approverId, phase: state.phase, guildId: row.guild_id }, "execution: final deny");
    return true;
  }

  const act = state.resolved_action;
  if (!act) {
    const committed = await commitClaimedExecutionTerminal(ctx, row, state, "cancelled");
    if (committed) await interaction.update({ components: approvalRows(flowId, true) }).catch(() => undefined);
    else await interaction.reply({ content: "状態の保存に失敗しました。再試行してください。", flags: MessageFlags.Ephemeral });
    return true;
  }

  const reason = buildExecutionAuditReason(approverId, buildPunishmentDetailJa(state));
  const durationSec = state.duration_seconds;
  const result = await carryOutPunishment(guild, state.target_id, act, durationSec, reason, ctx);

  const actionJa = actionLabelJa(act);
  const durJa = act === "timeout" ? `（${durationLabelFromSeconds(durationSec)}）` : "";

  if (result.ok) {
    const line = `# <@${state.target_id}> を **${actionJa}${durJa}** で処刑しました`;
    try {
      await textChannel.send({
        content: line,
        allowedMentions: { users: [state.target_id] },
      });
    } catch (err) {
      ctx.log.warn({ err, flowId, phase: state.phase, guildId: row.guild_id }, "execution: result message failed");
    }
  } else {
    try {
      await textChannel.send({ content: `処刑の実行に失敗しました: ${result.message}` });
    } catch (err) {
      ctx.log.warn({ err, flowId, phase: state.phase, guildId: row.guild_id }, "execution: error message failed");
    }
  }

  const committed = await commitClaimedExecutionTerminal(ctx, row, state, result.ok ? "completed" : "cancelled");
  if (!committed) {
    await interaction.reply({ content: "状態の保存に失敗しました。再試行してください。", flags: MessageFlags.Ephemeral });
    return true;
  }
  await interaction.update({ components: approvalRows(flowId, true) }).catch(() => undefined);
  await deleteFlowMessagesQuietly(ctx, textChannel, idsToDelete, "approve");
  ctx.log.info({ flowId, approverId, act, ok: result.ok, phase: state.phase, guildId: row.guild_id }, "execution: approved");
  return true;
}

export async function handleExecutionFlowButton(
  interaction: ButtonInteraction,
  ctx: BotContext,
): Promise<boolean> {
  if (interaction.customId.startsWith(EXEC_VOTE_PREFIX)) {
    return handleVote(interaction, ctx);
  }
  if (interaction.customId.startsWith(EXEC_APPROVAL_PREFIX)) {
    return handleApproval(interaction, ctx);
  }
  return false;
}

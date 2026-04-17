import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  DiscordAPIError,
  MessageFlags,
  PollLayoutType,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type Message,
  type PartialMessage,
  type TextChannel,
} from "discord.js";
import { randomUUID } from "node:crypto";
import type { BotContext } from "../../bot/context.js";
import { sqliteTimestamp } from "../../core/db/sqliteTimestamp.js";
import { isAdmin } from "../../core/permission.js";
import {
  buildExecutionAuditReason,
  clampTimeoutMs,
  EXECUTION_FLOW_KIND,
  EXECUTION_POLL_DURATION_HOURS,
  EXEC_APPROVE_PREFIX,
  EXEC_REJECT_PREFIX,
  POLL1_LABELS,
  POLL1_TIE_PRIORITY,
  POLL2_DURATION_MS,
  POLL2_LABELS,
  POLL2_TIE_PRIORITY,
} from "./executionConstants.js";
import type { ExecutionAction, ExecutionFlowState, ExecutionPhase } from "./executionFlow.types.js";
import { parseExecutionFlowState } from "./executionFlow.types.js";

function pollQuestion(text: string): { text: string } {
  return { text };
}

function buildPoll1Payload() {
  return {
    question: pollQuestion("処刑内容を選んでください"),
    answers: POLL1_LABELS.map((text) => ({ text })),
    duration: EXECUTION_POLL_DURATION_HOURS,
    allowMultiselect: false,
    layoutType: PollLayoutType.Default,
  };
}

function buildPoll2Payload() {
  return {
    question: pollQuestion("タイムアウト時間を選んでください"),
    answers: POLL2_LABELS.map((text) => ({ text })),
    duration: EXECUTION_POLL_DURATION_HOURS,
    allowMultiselect: false,
    layoutType: PollLayoutType.Default,
  };
}

export function pickWinningLabel(
  message: Message,
  candidateLabels: readonly string[],
  tieBreakOrder: readonly string[],
): string | null {
  const poll = message.poll;
  if (!poll?.resultsFinalized) return null;
  const counts = new Map<string, number>();
  for (const label of candidateLabels) counts.set(label, 0);
  for (const ans of poll.answers.values()) {
    const t = String(ans.text ?? "").trim();
    if (counts.has(t)) counts.set(t, ans.voteCount);
  }
  let max = -1;
  for (const v of counts.values()) {
    if (v > max) max = v;
  }
  for (const label of tieBreakOrder) {
    if ((counts.get(label) ?? 0) === max) return label;
  }
  return candidateLabels[0] ?? null;
}

function parsePollRowState(row: { state: unknown }): ExecutionFlowState | null {
  const raw = row.state as unknown;
  const obj = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  return parseExecutionFlowState(obj);
}

export async function findOpenExecutionFlowByMessageId(
  ctx: BotContext,
  guildId: string,
  messageId: string,
): Promise<{ row: { id: string; guild_id: string; status: string; message_id: string | null }; state: ExecutionFlowState } | null> {
  const row = await ctx.db
    .selectFrom("polls")
    .selectAll()
    .where("guild_id", "=", guildId)
    .where("kind", "=", EXECUTION_FLOW_KIND)
    .where("status", "=", "open")
    .where("message_id", "=", messageId)
    .executeTakeFirst();
  if (!row) return null;
  const state = parsePollRowState(row);
  if (!state) return null;
  return { row, state };
}

export async function findOpenExecutionFlowById(
  ctx: BotContext,
  flowId: string,
): Promise<{ row: { id: string; guild_id: string; status: string; message_id: string | null }; state: ExecutionFlowState } | null> {
  const row = await ctx.db
    .selectFrom("polls")
    .selectAll()
    .where("id", "=", flowId)
    .where("kind", "=", EXECUTION_FLOW_KIND)
    .where("status", "=", "open")
    .executeTakeFirst();
  if (!row) return null;
  const state = parsePollRowState(row);
  if (!state) return null;
  return { row, state };
}

async function saveFlowState(
  ctx: BotContext,
  flowId: string,
  patch: Partial<ExecutionFlowState> & { phase?: ExecutionPhase },
  messageId: string | null,
): Promise<void> {
  const cur = await findOpenExecutionFlowById(ctx, flowId);
  if (!cur) return;
  const next: ExecutionFlowState = { ...cur.state, ...patch };
  await ctx.db
    .updateTable("polls")
    .set({
      state: JSON.stringify(next) as unknown as Record<string, unknown>,
      message_id: messageId,
      updated_at: sqliteTimestamp() as unknown as Date,
    })
    .where("id", "=", flowId)
    .execute();
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

function labelToAction(label: string): ExecutionAction | null {
  if (label === "タイムアウト") return "timeout";
  if (label === "キック") return "kick";
  if (label === "BAN") return "ban";
  return null;
}

async function postAdminRequest(
  ctx: BotContext,
  channel: TextChannel,
  flowId: string,
): Promise<Message | null> {
  const adminRoleId = ctx.config.ADMIN_ROLE_ID.trim();
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${EXEC_APPROVE_PREFIX}${flowId}`)
      .setLabel("承認")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${EXEC_REJECT_PREFIX}${flowId}`)
      .setLabel("非承認")
      .setStyle(ButtonStyle.Danger),
  );
  try {
    return await channel.send({
      content: `<@&${adminRoleId}>\n> 管理者へのお願い。処刑フローを完了するため承認または非承認ボタンを押下して下さい`,
      components: [row],
      allowedMentions: { roles: [adminRoleId] },
    });
  } catch (err) {
    ctx.log.warn({ err, flowId }, "execution: admin request send failed");
    return null;
  }
}

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

  let invokerMember;
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

  let targetMember;
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
  const initialState: ExecutionFlowState = {
    phase: "poll1_pending",
    invoker_id: interaction.user.id,
    target_id: targetUser.id,
    channel_id: textChannel.id,
    poll1_message_id: "",
    poll2_message_id: null,
    admin_message_id: null,
    resolved_action: null,
    duration_ms: null,
    admin_button_fired: false,
  };

  await ctx.db
    .insertInto("polls")
    .values({
      id: flowId,
      guild_id: guild.id,
      channel_id: textChannel.id,
      message_id: null,
      kind: EXECUTION_FLOW_KIND,
      status: "open",
      state: JSON.stringify(initialState) as unknown as Record<string, unknown>,
      ends_at: null,
      created_at: sqliteTimestamp() as unknown as Date,
      updated_at: sqliteTimestamp() as unknown as Date,
    })
    .execute();

  let pollMsg: Message;
  try {
    pollMsg = await textChannel.send({
      content: `<@${targetUser.id}> への処刑投票です。`,
      poll: buildPoll1Payload(),
      allowedMentions: { users: [targetUser.id] },
    });
  } catch (err) {
    ctx.log.error({ err, flowId }, "execution: poll1 send failed");
    await ctx.db.deleteFrom("polls").where("id", "=", flowId).execute();
    await interaction.editReply({ content: "投票メッセージの送信に失敗しました。" });
    return;
  }

  const nextState: ExecutionFlowState = {
    ...initialState,
    poll1_message_id: pollMsg.id,
  };
  await ctx.db
    .updateTable("polls")
    .set({
      message_id: pollMsg.id,
      state: JSON.stringify(nextState) as unknown as Record<string, unknown>,
      updated_at: sqliteTimestamp() as unknown as Date,
    })
    .where("id", "=", flowId)
    .execute();

  await interaction.editReply({ content: "処刑投票を開始しました。" });
}

export async function onExecutionMessagePollMaybeFinalized(
  oldMessage: Message | PartialMessage,
  newMessage: Message | PartialMessage,
  ctx: BotContext,
): Promise<void> {
  let newM = newMessage;
  if (newM.partial) {
    try {
      newM = await newM.fetch();
    } catch {
      return;
    }
  }
  const botId = ctx.client.user?.id;
  if (!botId || newM.author.id !== botId) return;
  if (newM.guildId !== ctx.config.GUILD_ID) return;

  let oldM = oldMessage;
  if (oldM.partial) {
    try {
      oldM = await oldM.fetch();
    } catch {
      return;
    }
  }

  if (oldM.poll?.resultsFinalized === true) return;
  if (!newM.poll?.resultsFinalized) {
    try {
      newM = await newM.fetch(true);
    } catch {
      return;
    }
  }
  if (!newM.poll?.resultsFinalized) return;

  const found = await findOpenExecutionFlowByMessageId(ctx, newM.guildId!, newM.id);
  if (!found) return;

  const { row, state } = found;
  if (state.admin_button_fired) return;

  if (state.phase === "poll1_pending" && state.poll1_message_id === newM.id) {
    const winner = pickWinningLabel(newM, POLL1_LABELS as unknown as string[], POLL1_TIE_PRIORITY);
    if (!winner) {
      ctx.log.warn({ flowId: row.id }, "execution: poll1 no winner");
      return;
    }
    const action = labelToAction(winner);
    if (!action) return;

    const ch = (await ctx.client.channels.fetch(state.channel_id).catch(() => null)) as TextChannel | null;
    if (!ch?.isTextBased()) return;

    if (action === "timeout") {
      let poll2: Message;
      try {
        poll2 = await ch.send({
          content: `<@${state.target_id}> のタイムアウト時間を選んでください。`,
          poll: buildPoll2Payload(),
          allowedMentions: { users: [state.target_id] },
        });
      } catch (err) {
        ctx.log.error({ err, flowId: row.id }, "execution: poll2 send failed");
        return;
      }
      await saveFlowState(
        ctx,
        row.id,
        {
          phase: "poll2_pending",
          resolved_action: "timeout",
          poll2_message_id: poll2.id,
        },
        poll2.id,
      );
      ctx.log.info({ flowId: row.id }, "execution: transitioned poll1 -> poll2");
      return;
    }

    const adminMsg = await postAdminRequest(ctx, ch, row.id);
    await saveFlowState(
      ctx,
      row.id,
      {
        phase: "admin_pending",
        resolved_action: action,
        duration_ms: null,
        admin_message_id: adminMsg?.id ?? null,
      },
      null,
    );
    ctx.log.info({ flowId: row.id, action }, "execution: transitioned poll1 -> admin (kick/ban)");
    return;
  }

  if (state.phase === "poll2_pending" && state.poll2_message_id === newM.id) {
    const winner = pickWinningLabel(newM, POLL2_LABELS as unknown as string[], POLL2_TIE_PRIORITY);
    if (!winner) return;
    const rawMs = POLL2_DURATION_MS[winner];
    const durationMs = rawMs != null ? clampTimeoutMs(rawMs) : clampTimeoutMs(60_000);

    const ch = (await ctx.client.channels.fetch(state.channel_id).catch(() => null)) as TextChannel | null;
    if (!ch?.isTextBased()) return;

    const adminMsg = await postAdminRequest(ctx, ch, row.id);
    await saveFlowState(
      ctx,
      row.id,
      {
        phase: "admin_pending",
        resolved_action: "timeout",
        duration_ms: durationMs,
        admin_message_id: adminMsg?.id ?? null,
      },
      null,
    );
    ctx.log.info({ flowId: row.id, durationMs }, "execution: transitioned poll2 -> admin");
  }
}

function actionLabelJa(action: ExecutionAction): string {
  if (action === "timeout") return "タイムアウト";
  if (action === "kick") return "キック";
  return "BAN";
}

function durationLabelFromMs(ms: number | null): string {
  if (ms == null) return "";
  const sec = Math.floor(ms / 1000);
  if (sec < 120) return `${sec}秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)}分`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}時間`;
  if (sec < 86400 * 7) return `${Math.floor(sec / 86400)}日`;
  return `${Math.floor(sec / (86400 * 7))}週間`;
}

async function carryOutPunishment(
  guild: Guild,
  targetId: string,
  action: ExecutionAction,
  durationMs: number | null,
  reason: string,
  ctx: BotContext,
): Promise<{ ok: true } | { ok: false; message: string }> {
  let member;
  try {
    member = await guild.members.fetch(targetId);
  } catch {
    return { ok: false, message: "対象メンバーが見つかりません（退出済みなど）。" };
  }

  try {
    if (action === "timeout") {
      const ms = clampTimeoutMs(durationMs ?? 60_000);
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

export async function handleExecutionFlowButton(
  interaction: ButtonInteraction,
  ctx: BotContext,
): Promise<boolean> {
  const id = interaction.customId;
  const approve = id.startsWith(EXEC_APPROVE_PREFIX);
  const reject = id.startsWith(EXEC_REJECT_PREFIX);
  if (!approve && !reject) return false;

  const flowId = id.slice((approve ? EXEC_APPROVE_PREFIX : EXEC_REJECT_PREFIX).length);
  if (!flowId) return false;

  const found = await findOpenExecutionFlowById(ctx, flowId);
  if (!found || found.row.status !== "open") {
    await interaction.reply({ content: "このフローは期限切れか、既に処理済みです。", flags: MessageFlags.Ephemeral });
    return true;
  }

  const { row, state } = found;
  if (state.phase !== "admin_pending") {
    await interaction.reply({ content: "このフローはこの操作の段階ではありません。", flags: MessageFlags.Ephemeral });
    return true;
  }
  if (state.admin_button_fired) {
    await interaction.reply({ content: "すでに処理済みです。", flags: MessageFlags.Ephemeral });
    return true;
  }

  const guildForMember = interaction.guild;
  if (!guildForMember) {
    await interaction.reply({ content: "サーバー内でのみ操作できます。", flags: MessageFlags.Ephemeral });
    return true;
  }
  let operatorMember;
  try {
    operatorMember = await guildForMember.members.fetch(interaction.user.id);
  } catch {
    await interaction.reply({ content: "メンバー情報を取得できませんでした。", flags: MessageFlags.Ephemeral });
    return true;
  }
  if (!isAdmin(operatorMember, ctx.config)) {
    await interaction.reply({ content: "管理者のみ操作できます。", flags: MessageFlags.Ephemeral });
    return true;
  }

  if (interaction.channelId !== state.channel_id || interaction.guildId !== row.guild_id) {
    await interaction.reply({ content: "このチャンネルでは操作できません。", flags: MessageFlags.Ephemeral });
    return true;
  }

  await interaction.deferUpdate();

  const approverId = interaction.user.id;

  const guild = interaction.guild;
  if (!guild) return true;

  const ch = interaction.channel;
  if (!ch?.isTextBased() || ch.isDMBased()) return true;
  const textChannel = ch as TextChannel;

  const idsToDelete = [state.poll1_message_id, state.poll2_message_id, state.admin_message_id].filter(
    (x): x is string => Boolean(x),
  );

  if (reject) {
    try {
      await textChannel.send({ content: "処刑が非承認されたため、中止します" });
    } catch (err) {
      ctx.log.warn({ err, flowId }, "execution: abort message failed");
    }

    await deleteFlowMessagesQuietly(ctx, textChannel, idsToDelete, "reject");

    await ctx.db
      .updateTable("polls")
      .set({
        status: "cancelled",
        state: JSON.stringify({
          ...state,
          phase: "cancelled",
          admin_button_fired: true,
        }) as unknown as Record<string, unknown>,
        updated_at: sqliteTimestamp() as unknown as Date,
      })
      .where("id", "=", flowId)
      .execute();

    ctx.log.info({ flowId, approverId }, "execution: rejected");
    return true;
  }

  const action = state.resolved_action;
  if (!action) {
    await ctx.db
      .updateTable("polls")
      .set({
        status: "cancelled",
        updated_at: sqliteTimestamp() as unknown as Date,
      })
      .where("id", "=", flowId)
      .execute();
    return true;
  }

  if (state.admin_message_id) {
    try {
      const adm = await textChannel.messages.fetch(state.admin_message_id).catch(() => null);
      if (adm) {
        await adm.edit({
          content: `<@${approverId}> が承認しました。`,
          components: [],
        });
      }
    } catch {
      /* noop */
    }
  }

  const reason = buildExecutionAuditReason(approverId);
  const result = await carryOutPunishment(guild, state.target_id, action, state.duration_ms, reason, ctx);

  const actionJa = actionLabelJa(action);
  const durJa = action === "timeout" ? `（${durationLabelFromMs(state.duration_ms)}）` : "";

  if (result.ok) {
    const line = `# <@${state.target_id}> を **${actionJa}${durJa}** で処刑しました`;
    try {
      await textChannel.send({
        content: line,
        allowedMentions: { users: [state.target_id] },
      });
    } catch (err) {
      ctx.log.warn({ err, flowId }, "execution: result message failed");
    }
  } else {
    try {
      await textChannel.send({
        content: `処刑の実行に失敗しました: ${result.message}`,
      });
    } catch (err) {
      ctx.log.warn({ err, flowId }, "execution: error message failed");
    }
  }

  await deleteFlowMessagesQuietly(ctx, textChannel, idsToDelete, "approve");

  await ctx.db
    .updateTable("polls")
    .set({
      status: "completed",
      state: JSON.stringify({
        ...state,
        phase: "completed",
        admin_button_fired: true,
      }) as unknown as Record<string, unknown>,
      updated_at: sqliteTimestamp() as unknown as Date,
    })
    .where("id", "=", flowId)
    .execute();

  ctx.log.info({ flowId, approverId, action, ok: result.ok }, "execution: approved and finished");
  return true;
}

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

const adminWaitTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearAdminWait(flowId: string): void {
  const t = adminWaitTimers.get(flowId);
  if (t) clearTimeout(t);
  adminWaitTimers.delete(flowId);
}

function memberHasRoleId(member: GuildMember, roleId: string): boolean {
  const id = roleId.trim();
  if (!id) return false;
  return member.roles.cache.has(id);
}

function parsePollRowState(row: { state: unknown }): ExecutionFlowState | null {
  const raw = row.state as unknown;
  const obj = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  return parseExecutionFlowState(obj);
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

async function saveFullState(
  ctx: BotContext,
  flowId: string,
  state: ExecutionFlowState,
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

function parseExecVote(customId: string): { flowId: string; choice: string } | null {
  if (!customId.startsWith(EXEC_VOTE_PREFIX)) return null;
  const rest = customId.slice(EXEC_VOTE_PREFIX.length);
  const idx = rest.lastIndexOf(":");
  if (idx <= 0) return null;
  return { flowId: rest.slice(0, idx), choice: rest.slice(idx + 1) };
}

function parseExecApproval(customId: string): { flowId: string; action: "approve" | "deny" } | null {
  if (!customId.startsWith(EXEC_APPROVAL_PREFIX)) return null;
  const rest = customId.slice(EXEC_APPROVAL_PREFIX.length);
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

/** PublicExecution.winnerChoice と同様: 唯一の最多票がない場合は null */
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

function choiceToAction1(c: string): ExecutionAction | null {
  if (c === "1") return "timeout";
  if (c === "2") return "kick";
  if (c === "3") return "ban";
  return null;
}

/** 処刑フロー第1投票（処刑内容）。`pollEnded` 後は `:R` を使わず増加表示を防ぐ */
function buildPoll1Embed(state: ExecutionFlowState, poll1DeadlineMs: number, pollEnded = false): EmbedBuilder {
  const counts = tallyChoices(state.votes_poll1, POLL1_KEYS);
  const lines = POLL1_KEYS.map((k) => `**${k}.** ${POLL1_LABEL[k]} — ${counts[k] ?? 0} 票`);
  return new EmbedBuilder()
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
    .setColor(0x3498db)
    .setTimestamp(new Date());
}

/** 処刑フロー第2投票（タイムアウト時間） */
function buildPoll2Embed(state: ExecutionFlowState, poll2DeadlineMs: number, pollEnded = false): EmbedBuilder {
  const counts = tallyChoices(state.votes_poll2, POLL2_KEYS);
  const lines = POLL2_KEYS.map((k) => `**${k}.** ${POLL2_LABEL[k]} — ${counts[k] ?? 0} 票`);
  return new EmbedBuilder()
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
    .setColor(0x9b59b6)
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
      ctx.log.warn({ err, mid }, "execution: edit stopped message failed");
    }
  }
}

async function abortFlow(
  ctx: BotContext,
  flowId: string,
  state: ExecutionFlowState,
  heading: string,
): Promise<void> {
  clearAdminWait(flowId);
  const ch = (await ctx.client.channels.fetch(state.channel_id).catch(() => null)) as TextChannel | null;
  if (ch?.isTextBased()) {
    await editMessagesStopped(ctx, ch, [state.precheck_message_id, state.poll1_message_id, state.poll2_message_id, state.admin_message_id], heading);
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

function scheduleAdminWait(ctx: BotContext, flowId: string, expectedPhase: "precheck_pending" | "admin_pending"): void {
  clearAdminWait(flowId);
  const ms = ctx.config.EXEC_ADMIN_WAIT_SECONDS * 1000;
  const h = setTimeout(() => {
    void (async () => {
      const found = await findOpenExecutionFlowById(ctx, flowId);
      if (!found || found.state.phase !== expectedPhase || found.state.admin_button_fired) return;
      ctx.log.info({ flowId, expectedPhase }, "execution: admin wait timeout");
      await abortFlow(ctx, flowId, found.state, "処刑フロー: 承認がタイムアウトしました");
    })().catch((err) => ctx.log.error({ err, flowId }, "execution: admin timeout handler failed"));
  }, ms);
  adminWaitTimers.set(flowId, h);
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

async function beginPoll1(ctx: BotContext, flowId: string, state: ExecutionFlowState): Promise<void> {
  const ch = (await ctx.client.channels.fetch(state.channel_id).catch(() => null)) as TextChannel | null;
  if (!ch?.isTextBased()) return;

  const voteMs = ctx.config.EXEC_VOTE_SECONDS * 1000;
  const deadline = Date.now() + voteMs;
  const embed = buildPoll1Embed({ ...state, poll1_deadline_ms: deadline, votes_poll1: {} }, deadline);

  let msg: Message;
  try {
    msg = await ch.send({
      embeds: [embed],
      components: poll1Rows(flowId, false),
      allowedMentions: { users: [state.target_id] },
    });
  } catch (err) {
    ctx.log.error({ err, flowId }, "execution: poll1 send failed");
    await abortFlow(ctx, flowId, state, "処刑フロー: 投票メッセージの送信に失敗しました");
    return;
  }

  const next: ExecutionFlowState = {
    ...state,
    phase: "poll1_pending",
    poll1_message_id: msg.id,
    poll1_deadline_ms: deadline,
    votes_poll1: {},
  };
  await saveFullState(ctx, flowId, next, msg.id);
  setTimeout(() => {
    void transitionPoll1ToNext(ctx, flowId).catch((err) => ctx.log.error({ err, flowId }, "execution: poll1 finalize failed"));
  }, voteMs);
}

async function transitionPoll1ToNext(ctx: BotContext, flowId: string): Promise<void> {
  const found = await findOpenExecutionFlowById(ctx, flowId);
  if (!found || found.state.phase !== "poll1_pending") return;

  const { state } = found;

  const counts = tallyChoices(state.votes_poll1, POLL1_KEYS);
  const winner = pickSingleWinner(counts, [...POLL1_KEYS]);
  const ch = (await ctx.client.channels.fetch(state.channel_id).catch(() => null)) as TextChannel | null;
  if (!ch?.isTextBased()) return;

  if (state.poll1_message_id) {
    try {
      const m = await ch.messages.fetch(state.poll1_message_id).catch(() => null);
      if (m) {
        await m.edit({
          content: null,
          embeds: [buildPoll1Embed(state, state.poll1_deadline_ms, true)],
          components: poll1Rows(flowId, true),
        });
      }
    } catch {
      /* noop */
    }
  }

  if (winner == null) {
    await abortFlow(ctx, flowId, state, "処刑フロー: 投票の最多票が確定しませんでした");
    return;
  }

  const action = choiceToAction1(winner);
  if (!action) return;

  if (action === "timeout") {
    const voteMs = ctx.config.EXEC_VOTE_SECONDS * 1000;
    const deadline = Date.now() + voteMs;
    const poll2Embed = buildPoll2Embed(
      { ...state, poll2_deadline_ms: deadline, votes_poll2: {}, phase: "poll2_pending" },
      deadline,
    );
    let msg: Message;
    try {
      msg = await ch.send({
        embeds: [poll2Embed],
        components: poll2Rows(flowId, false),
        allowedMentions: { users: [state.target_id] },
      });
    } catch (err) {
      ctx.log.error({ err, flowId }, "execution: poll2 send failed");
      await abortFlow(ctx, flowId, state, "処刑フロー: タイムアウト時間投票の送信に失敗しました");
      return;
    }

    const next: ExecutionFlowState = {
      ...state,
      phase: "poll2_pending",
      resolved_action: "timeout",
      poll2_message_id: msg.id,
      poll2_deadline_ms: deadline,
      votes_poll2: {},
    };
    await saveFullState(ctx, flowId, next, msg.id);
    setTimeout(() => {
      void transitionPoll2ToAdmin(ctx, flowId).catch((err) => ctx.log.error({ err, flowId }, "execution: poll2 finalize failed"));
    }, voteMs);
    return;
  }

  const targetName = `<@${state.target_id}>`;
  const detail = action === "kick" ? "キック" : "BAN";
  const adminMsg = await postAdminRequest(
    ctx,
    ch,
    flowId,
    `処刑の最終承認: ${targetName} → ${detail}`,
  );
  const next: ExecutionFlowState = {
    ...state,
    phase: "admin_pending",
    resolved_action: action,
    duration_seconds: null,
    admin_message_id: adminMsg?.id ?? null,
  };
  await saveFullState(ctx, flowId, next, null);
  scheduleAdminWait(ctx, flowId, "admin_pending");
}

async function transitionPoll2ToAdmin(ctx: BotContext, flowId: string): Promise<void> {
  const found = await findOpenExecutionFlowById(ctx, flowId);
  if (!found || found.state.phase !== "poll2_pending") return;

  const { state } = found;

  const counts = tallyChoices(state.votes_poll2, POLL2_KEYS);
  const winner = pickSingleWinner(counts, [...POLL2_KEYS]);
  const ch = (await ctx.client.channels.fetch(state.channel_id).catch(() => null)) as TextChannel | null;
  if (!ch?.isTextBased()) return;

  if (state.poll2_message_id && state.poll2_deadline_ms) {
    try {
      const m = await ch.messages.fetch(state.poll2_message_id).catch(() => null);
      if (m) {
        await m.edit({
          content: null,
          embeds: [buildPoll2Embed(state, state.poll2_deadline_ms, true)],
          components: poll2Rows(flowId, true),
        });
      }
    } catch {
      /* noop */
    }
  }

  if (winner == null) {
    await abortFlow(ctx, flowId, state, "処刑フロー: タイムアウト時間の最多票が確定しませんでした");
    return;
  }

  const sec = POLL2_CHOICE_TO_SECONDS[winner as keyof typeof POLL2_CHOICE_TO_SECONDS];
  const durationSeconds = sec ?? 60;
  const label = POLL2_LABEL[winner as keyof typeof POLL2_LABEL] ?? winner;

  const adminMsg = await postAdminRequest(
    ctx,
    ch,
    flowId,
    `処刑の最終承認: <@${state.target_id}> → タイムアウト（${label}）`,
  );
  const next: ExecutionFlowState = {
    ...state,
    phase: "admin_pending",
    resolved_action: "timeout",
    duration_seconds: durationSeconds,
    admin_message_id: adminMsg?.id ?? null,
  };
  await saveFullState(ctx, flowId, next, null);
  scheduleAdminWait(ctx, flowId, "admin_pending");
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
  const executorRole = ctx.config.EXECUTOR_ROLE_ID?.trim();
  const needsPrecheck = Boolean(executorRole && !memberHasRoleId(targetMember, executorRole));

  const baseState: ExecutionFlowState = {
    phase: needsPrecheck ? "precheck_pending" : "poll1_pending",
    invoker_id: interaction.user.id,
    target_id: targetUser.id,
    channel_id: textChannel.id,
    precheck_message_id: null,
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
    })
    .execute();

  if (needsPrecheck) {
    const pre = await postPrecheckRequest(ctx, textChannel, flowId);
    const st: ExecutionFlowState = {
      ...baseState,
      precheck_message_id: pre?.id ?? null,
    };
    await saveFullState(ctx, flowId, st, null);
    scheduleAdminWait(ctx, flowId, "precheck_pending");
    await interaction.editReply({ content: "管理者の事前承認を待っています。" });
    return;
  }

  await beginPoll1(ctx, flowId, baseState);
  await interaction.editReply({ content: "処刑投票を開始しました。" });
}

async function handleVote(interaction: ButtonInteraction, ctx: BotContext): Promise<boolean> {
  const parsed = parseExecVote(interaction.customId);
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

  const { state } = found;
  if (interaction.channelId !== state.channel_id || interaction.guildId !== found.row.guild_id) {
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
    const votes = { ...state.votes_poll1, [interaction.user.id]: choice } as ExecutionFlowState["votes_poll1"];
    const next: ExecutionFlowState = { ...state, votes_poll1: votes };
    await saveFullState(ctx, flowId, next, state.poll1_message_id);

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
        await m.edit({
          content: null,
          embeds: [buildPoll1Embed(next, next.poll1_deadline_ms)],
          components: poll1Rows(flowId, false),
        });
      } catch (err) {
        ctx.log.warn({ err, flowId }, "execution: poll1 edit failed");
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
    const votes = { ...state.votes_poll2, [interaction.user.id]: choice } as ExecutionFlowState["votes_poll2"];
    const next: ExecutionFlowState = { ...state, votes_poll2: votes };
    await saveFullState(ctx, flowId, next, state.poll2_message_id);

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
        await m.edit({
          content: null,
          embeds: [buildPoll2Embed(next, next.poll2_deadline_ms!)],
          components: poll2Rows(flowId, false),
        });
      } catch (err) {
        ctx.log.warn({ err, flowId }, "execution: poll2 edit failed");
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
  const parsed = parseExecApproval(interaction.customId);
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
    await interaction.update({ components: approvalRows(flowId, true) }).catch(() => undefined);
    clearAdminWait(flowId);
    if (action === "deny") {
      await abortFlow(ctx, flowId, state, "処刑フロー: 事前承認が拒否されました");
      return true;
    }
    const next: ExecutionFlowState = { ...state, phase: "poll1_pending", precheck_message_id: state.precheck_message_id };
    await saveFullState(ctx, flowId, next, null);
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

  await interaction.update({ components: approvalRows(flowId, true) }).catch(() => undefined);
  clearAdminWait(flowId);

  const approverId = interaction.user.id;
  const textChannel = interaction.channel as TextChannel;

  const idsToDelete = [state.precheck_message_id, state.poll1_message_id, state.poll2_message_id, state.admin_message_id].filter(
    (x): x is string => Boolean(x),
  );

  const nextFired: ExecutionFlowState = { ...state, admin_button_fired: true };

  if (action === "deny") {
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
        state: JSON.stringify({ ...nextFired, phase: "cancelled" }) as unknown as Record<string, unknown>,
        updated_at: sqliteTimestamp() as unknown as Date,
      })
      .where("id", "=", flowId)
      .execute();
    ctx.log.info({ flowId, approverId }, "execution: final deny");
    return true;
  }

  const act = state.resolved_action;
  if (!act) {
    await ctx.db
      .updateTable("polls")
      .set({ status: "cancelled", updated_at: sqliteTimestamp() as unknown as Date })
      .where("id", "=", flowId)
      .execute();
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
      ctx.log.warn({ err, flowId }, "execution: result message failed");
    }
  } else {
    try {
      await textChannel.send({ content: `処刑の実行に失敗しました: ${result.message}` });
    } catch (err) {
      ctx.log.warn({ err, flowId }, "execution: error message failed");
    }
  }

  await deleteFlowMessagesQuietly(ctx, textChannel, idsToDelete, "approve");

  await ctx.db
    .updateTable("polls")
    .set({
      status: "completed",
      state: JSON.stringify({ ...nextFired, phase: "completed" }) as unknown as Record<string, unknown>,
      updated_at: sqliteTimestamp() as unknown as Date,
    })
    .where("id", "=", flowId)
    .execute();

  ctx.log.info({ flowId, approverId, act, ok: result.ok }, "execution: approved");
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

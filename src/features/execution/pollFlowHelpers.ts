import {
  MessageFlags,
  type ActionRowBuilder,
  type ButtonBuilder,
  type Message,
  type TextChannel,
} from "discord.js";
import type { CoreDeps } from "../../core/deps.js";
import { ComponentCardBuilder, componentCardsPayload } from "../../core/componentCard.js";
import { flowTargetLocks, normalizePollStateRevision } from "./flowLifecycle.js";
import { parsePersistedFlowState } from "./twoStagePollTally.js";

// 投票フローの共通処理が使う依存。
type PollFlowHelperDeps = Pick<CoreDeps, "config" | "db" | "log">;

export type OpenPollFlowRow = {
  id: string;
  guild_id: string;
  status: string;
  message_id: string | null;
  state: unknown;
  state_revision: number;
  updated_at: Date;
};

export function createFlowTargetTracker(namespace: string) {
  const targets = new Map<string, { guildId: string; targetId: string }>();
  return {
    get(flowId: string) {
      return targets.get(flowId);
    },
    retain(flowId: string, guildId: string, targetId: string): boolean {
      const current = targets.get(flowId);
      if (current) return current.guildId === guildId && current.targetId === targetId;
      if (!flowTargetLocks.acquire(namespace, guildId, targetId)) return false;
      targets.set(flowId, { guildId, targetId });
      return true;
    },
    release(flowId: string): void {
      const target = targets.get(flowId);
      if (!target) return;
      flowTargetLocks.release(namespace, target.guildId, target.targetId);
      targets.delete(flowId);
    },
    releaseAll(): void {
      for (const flowId of [...targets.keys()]) {
        this.release(flowId);
      }
    },
  };
}

export function adminWaitDeadlineMs(updatedAt: Date, waitSeconds: number): number {
  const updatedAtMs = new Date(updatedAt).getTime();
  const base = Number.isFinite(updatedAtMs) ? updatedAtMs : Date.now();
  return base + waitSeconds * 1000;
}

export async function findOpenPollFlowById<TState>(
  ctx: PollFlowHelperDeps,
  flowId: string,
  kind: string,
  parse: (raw: unknown) => TState | null,
  logPrefix: string,
): Promise<{ row: OpenPollFlowRow; state: TState } | null> {
  const row = await ctx.db
    .selectFrom("polls")
    .select(["id", "guild_id", "status", "message_id", "state", "state_revision", "updated_at"])
    .where("id", "=", flowId)
    .where("kind", "=", kind)
    .where("status", "=", "open")
    .executeTakeFirst();
  if (!row) return null;
  const stateRevision = normalizePollStateRevision(row.state_revision);
  if (stateRevision === null) {
    ctx.log.error(
      { flowId, guildId: row.guild_id, phase: "invalid_state_revision", stateRevision: row.state_revision },
      `${logPrefix}: ignoring unsafe flow state revision`,
    );
    return null;
  }
  const state = parsePersistedFlowState(row.state, parse);
  if (!state) return null;
  return { row: { ...row, state_revision: stateRevision }, state };
}

export async function deletePollFlowMessagesQuietly(
  ctx: PollFlowHelperDeps,
  channel: TextChannel,
  messageIds: string[],
  logPrefix: string,
  logLabel: string,
): Promise<void> {
  for (const id of messageIds) {
    try {
      const m = await channel.messages.fetch(id);
      if (m) await m.delete();
    } catch (err) {
      ctx.log.warn({ err, id, logLabel }, `${logPrefix}: delete flow message failed`);
    }
  }
}

export async function editPollMessagesStopped(
  ctx: PollFlowHelperDeps,
  channel: TextChannel,
  messages: Array<{ id: string | null | undefined; components: ActionRowBuilder<ButtonBuilder>[] }>,
  heading: string,
  logPrefix: string,
): Promise<void> {
  const content = `# **${heading}**`;
  for (const { id: mid, components } of messages) {
    if (!mid) continue;
    try {
      const m = await channel.messages.fetch(mid);
      // Components V2 メッセージは content を持てないため、見出しカードへ差し替える
      await m.edit(
        m.flags?.has(MessageFlags.IsComponentsV2)
          ? componentCardsPayload([new ComponentCardBuilder().setDescription(content)], components)
          : { content, embeds: [], components },
      );
    } catch (err) {
      ctx.log.warn({ err, mid }, `${logPrefix}: edit stopped message failed`);
    }
  }
}

export async function postPollAdminRequest(
  ctx: PollFlowHelperDeps,
  channel: TextChannel,
  flowId: string,
  body: string,
  components: ActionRowBuilder<ButtonBuilder>[],
  logPrefix: string,
): Promise<Message | null> {
  const adminRoleId = ctx.config.ADMIN_ROLE_ID.trim();
  try {
    return await channel.send({
      content: `${body}\n<@&${adminRoleId}>`,
      components,
      allowedMentions: { roles: [adminRoleId] },
    });
  } catch (err) {
    ctx.log.warn({ err, flowId }, `${logPrefix}: admin request send failed`);
    return null;
  }
}

export async function disablePollMessage(
  channel: TextChannel,
  messageId: string | null,
  payload: ReturnType<typeof componentCardsPayload>,
): Promise<void> {
  if (!messageId) return;
  try {
    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (message) await message.edit(payload);
  } catch {
    // UI の無効化失敗は状態確定を巻き戻さない
  }
}

export function formatDurationLabelJa(sec: number | null): string {
  if (sec == null) return "";
  if (sec < 120) return `${sec}秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)}分`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}時間`;
  if (sec < 86400 * 7) return `${Math.floor(sec / 86400)}日`;
  return `${Math.floor(sec / (86400 * 7))}週間`;
}

export function buildApprovedAuditReason(
  prefix: string,
  detailJa: string,
  approverUserId: string,
  approvalNote = "管理者が承認。",
): string {
  const text = `${prefix}（${detailJa}）。${approvalNote}`;
  const suffix = ` approved_by=${approverUserId}`;
  const full = `${text}${suffix}`;
  const max = 512;
  if (full.length <= max) return full;
  const keep = max - suffix.length;
  return `${text.slice(0, Math.max(0, keep))}${suffix}`;
}

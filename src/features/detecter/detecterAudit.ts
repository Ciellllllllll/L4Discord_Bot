import {
  AuditLogEvent,
  type Guild,
  type GuildAuditLogsEntry,
} from "discord.js";
import { setTimeout as delay } from "node:timers/promises";
import { getDiscordErrorCode } from "../../core/discordErrors.js";
import { normalizeSnowflake } from "../../core/snowflake.js";

function isTransientAuditFetchError(error: unknown): boolean {
  if (error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError) {
    return false;
  }
  const discordCode = getDiscordErrorCode(error);
  if (discordCode !== null) {
    return false;
  }
  if (error && typeof error === "object" && "status" in error) {
    const status = Number((error as { status: unknown }).status);
    if (Number.isFinite(status)) {
      return status === 429 || status >= 500;
    }
  }
  return true;
}

export type AuditLookupResult = {
  actorId: string;
  actorDisplay: string;
  reason: string;
  hasExplicitAuditReason: boolean;
  auditId: string;
  createdAt: Date;
  communicationDisabledUntilFromAudit: Date | null;
};

export function safeText(value: unknown, fallback = "-"): string {
  const text = value === null || value === undefined ? "" : String(value).trim();
  return text || fallback;
}

export function userDisplayName(
  u: { username?: string | null; globalName?: string | null } | null | undefined,
): string {
  const name = u?.username;
  if (name == null || name === "") return "不明";
  return safeText(u?.globalName ?? name, "不明");
}

export function extractPublicExecutionApprover(reasonText: string): string {
  const m = /approved_by=(\d+)/.exec(reasonText || "");
  return m ? (normalizeSnowflake(m[1]) ?? "") : "";
}

export function entryHasTimeoutChange(entry: GuildAuditLogsEntry): boolean {
  try {
    for (const change of entry.changes ?? []) {
      const key = String(change.key ?? "");
      if (["communication_disabled_until", "timed_out_until", "timeout_until"].includes(key)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function parseAuditTimeoutRaw(raw: unknown): Date | null {
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
    return parseAuditTimeoutRaw((raw as { value: unknown }).value);
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

// 同一エントリに複数の timeout 系 change があり先頭の new が null の場合があるため、最も遅い有効日時を採用する。
export function parseCommunicationDisabledUntilFromEntry(entry: GuildAuditLogsEntry): Date | null {
  try {
    let best: Date | null = null;
    for (const c of entry.changes ?? []) {
      const key = String(c.key ?? "");
      if (!["communication_disabled_until", "timed_out_until", "timeout_until"].includes(key)) continue;
      const d = parseAuditTimeoutRaw(c.new);
      if (d && (!best || d.getTime() > best.getTime())) best = d;
    }
    return best;
  } catch {
    return null;
  }
}

export async function findAuditLogForTarget(input: {
  guild: Guild;
  action: AuditLogEvent;
  targetUserId: string;
  requireTimeoutChange?: boolean;
  auditWindowSec: number;
  defaultReasonText: string;
  isProcessedAuditId: (auditId: string) => boolean;
  warn: (meta: Record<string, unknown>, message: string) => void;
  retryDelaysMs?: readonly number[];
}): Promise<AuditLookupResult | null> {
  const normalizedTargetId = normalizeSnowflake(input.targetUserId);
  if (!normalizedTargetId) return null;

  const me = input.guild.members.me;
  if (!me?.permissions.has("ViewAuditLog")) return null;

  const retries = input.retryDelaysMs ?? [250, 800, 1500];
  for (const wait of retries) {
    if (wait > 0) await delay(wait);
    try {
      const audits = await input.guild.fetchAuditLogs({ limit: 50, type: input.action });
      for (const entry of audits.entries.values()) {
        const entryTargetId = normalizeSnowflake(entry.target && "id" in entry.target ? entry.target.id : "");
        if (entryTargetId !== normalizedTargetId) continue;
        const auditId = normalizeSnowflake(entry.id);
        if (!auditId || input.isProcessedAuditId(auditId)) continue;

        const createdAt = entry.createdAt;
        if ((Date.now() - createdAt.getTime()) / 1000 > input.auditWindowSec) continue;
        if (input.requireTimeoutChange && !entryHasTimeoutChange(entry)) continue;

        const communicationDisabledUntilFromAudit = entryHasTimeoutChange(entry)
          ? parseCommunicationDisabledUntilFromEntry(entry)
          : null;
        if (input.requireTimeoutChange) {
          if (!communicationDisabledUntilFromAudit || communicationDisabledUntilFromAudit.getTime() <= Date.now()) {
            continue;
          }
        }

        const rawReason = entry.reason;
        return {
          actorId: normalizeSnowflake(entry.executor?.id) ?? "",
          actorDisplay: userDisplayName(entry.executor),
          reason: safeText(entry.reason, input.defaultReasonText),
          hasExplicitAuditReason: rawReason != null && String(rawReason).trim() !== "",
          auditId,
          createdAt,
          communicationDisabledUntilFromAudit,
        };
      }
    } catch (err) {
      input.warn({ err }, "detecter: failed to inspect audit log");
      if (!isTransientAuditFetchError(err)) {
        return null;
      }
    }
  }
  return null;
}

// DiscordBotv2 remindersystem.js の編集モーダル customId 接頭辞

export const EDIT_MODAL_PREFIX = "rem_manage_edit_modal";
export const DISCORD_CUSTOM_ID_MAX = 100;

export function buildEditModalCustomId(rowId: string, fireAtIso: string): string | null {
  const parsedMs = Date.parse(fireAtIso);
  // fire_at がパースできない旧データ等では番兵値 0 を使い、編集モーダルを開けるようにする。
  const fireAtMs = Number.isFinite(parsedMs) && parsedMs >= 0 ? parsedMs : 0;
  const withFireAt = `${EDIT_MODAL_PREFIX}:${rowId}:${fireAtMs}`;
  // rowId は UUID (36文字) のため通常は 72 文字前後で DISCORD_CUSTOM_ID_MAX (100文字) を超えない。
  // 万が一超える場合も fire_at なしの旧形式へフォールバックせず null を返す。
  if (withFireAt.length > DISCORD_CUSTOM_ID_MAX) {
    return null;
  }
  return withFireAt;
}

export function parseEditModalCustomId(
  customId: string,
): { rowId: string; modalFireAtMs: number | null } | null {
  const prefix = `${EDIT_MODAL_PREFIX}:`;
  if (!customId.startsWith(prefix)) return null;
  const suffix = customId.slice(prefix.length);
  if (!suffix) return null;
  const lastColon = suffix.lastIndexOf(":");
  if (lastColon > 0) {
    const maybeMs = suffix.slice(lastColon + 1);
    if (/^\d+$/.test(maybeMs)) {
      const parsedMs = Number(maybeMs);
      if (Number.isSafeInteger(parsedMs)) {
        return { rowId: suffix.slice(0, lastColon), modalFireAtMs: parsedMs };
      }
    }
  }
  return { rowId: suffix, modalFireAtMs: null };
}

// モーダル入力の繰り返し欄（`10m` 形式）

export const RECURRENCE_INPUT_MAX = 20;

export type ReminderEvType = "reminder" | "todo" | "notice";

export const EVENT_META: Record<
  ReminderEvType,
  { label: string; color: number; createLabel: string }
> = {
  reminder: { label: "リマインダー", color: 0x1abc9c, createLabel: "リマインダー作成" },
  todo: { label: "TODO", color: 0x3498db, createLabel: "TODO作成" },
  notice: { label: "運営お知らせ", color: 0xe67e22, createLabel: "運営お知らせ作成" },
};

export const EVENT_TYPES = Object.keys(EVENT_META) as ReminderEvType[];

export type ReminderStoredData = {
  ev_type: ReminderEvType;
  title: string;
  recurrence?: { interval_sec: number } | null;
};

export function normalizeEventType(kind: string): ReminderEvType {
  return EVENT_TYPES.includes(kind as ReminderEvType) ? (kind as ReminderEvType) : "reminder";
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function parseDueAt(text: string): Date | null {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const rel = /^\+(\d+)([smhd])$/i.exec(raw);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const mul = unit === "s" ? 1000 : unit === "m" ? 60000 : unit === "h" ? 3600000 : 86400000;
    return new Date(Date.now() + n * mul);
  }

  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) {
    return d;
  }
  return null;
}

export function parseRecurrence(text: string): { interval_sec: number } | null {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const rel = /^(\d+)([smhd])$/i.exec(raw);
  if (!rel) return null;
  const n = Number(rel[1]);
  const unit = rel[2].toLowerCase();
  const sec = unit === "s" ? n : unit === "m" ? n * 60 : unit === "h" ? n * 3600 : n * 86400;
  return { interval_sec: sec };
}

export function parseRecurrenceInput(text: string): { valid: boolean; value: { interval_sec: number } | null; raw: string } {
  const raw = String(text || "").trim();
  if (!raw) return { valid: true, value: null, raw: "" };
  const parsed = parseRecurrence(raw);
  if (!parsed) return { valid: false, value: null, raw };
  return { valid: true, value: parsed, raw };
}

export function parseRecurrenceJson(recurrenceJson: string | null | undefined): { interval_sec: number } | null {
  if (!recurrenceJson) return null;
  try {
    const parsed = JSON.parse(recurrenceJson) as unknown;
    if (parsed && typeof parsed === "object" && parsed !== null && "interval_sec" in parsed) {
      const sec = Number((parsed as { interval_sec: unknown }).interval_sec);
      if (Number.isFinite(sec) && sec > 0) return { interval_sec: sec };
    }
  } catch {
    return null;
  }
  return null;
}

export function recurrenceToInput(recurrenceJson: string | null | undefined): string {
  const recurrence = parseRecurrenceJson(recurrenceJson);
  if (!recurrence) return "";
  const sec = Number(recurrence.interval_sec);
  if (!Number.isFinite(sec) || sec <= 0) return "";
  if (sec % 86400 === 0) return `${sec / 86400}d`;
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

export function dueToInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString();
}

export function formatDue(iso: string): string {
  const t = Math.floor(new Date(iso).getTime() / 1000);
  if (!Number.isFinite(t) || t <= 0) return "不明";
  return `<t:${t}:F>`;
}

export function formatRecurrenceLabel(recurrenceJson: string | null | undefined): string {
  const recurrence = parseRecurrenceJson(recurrenceJson);
  if (!recurrence) return "なし";
  return recurrenceToInput(recurrenceJson) || "あり";
}

export function cut(text: string, max: number): string {
  const value = String(text || "");
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

import { ComponentCardBuilder } from "../../core/componentCard.js";
import { safeText } from "./detecterAudit.js";

export type PunishmentType = "ban" | "kick" | "timeout";

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

export function formatPunishmentType(punishmentType: string): string {
  if (punishmentType === "timeout") return "タイムアウト";
  if (punishmentType === "kick") return "キック";
  if (punishmentType === "ban") return "BAN";
  return safeText(punishmentType, "不明");
}

function fmtDt(dt: Date | null | undefined): string {
  if (!dt) return "-";
  return `<t:${Math.floor(dt.getTime() / 1000)}:F>`;
}

export function buildDetecterStatusDisplayText(
  event: PunishmentEvent,
  cfg: { DETECTER_DEFAULT_REASON_TEXT: string },
): string {
  const r = safeText(event.detectedReason, cfg.DETECTER_DEFAULT_REASON_TEXT);
  const auditLine = r === cfg.DETECTER_DEFAULT_REASON_TEXT
    ? "未入力（下の「理由」欄に入力してください）"
    : `参照: ${r.slice(0, 500)}`;
  return ["審査待ち：モデレーターによる理由入力待ち", `監査ログの理由：${auditLine}`].join("\n");
}

function buildPunishmentCommonFields(
  event: PunishmentEvent,
  reasonText: string,
  defaultReasonText: string,
) {
  const fields = [
    { name: "実行者", value: `${event.actorDisplay} (\`${event.actorUserId}\`)`, inline: false },
    { name: "サーバー", value: `${event.guildName} (${event.guildId})`, inline: false },
    { name: "対象ユーザー", value: `${event.targetDisplay} (\`${event.targetUserId}\`)`, inline: false },
    { name: "処罰種別", value: formatPunishmentType(event.punishmentType), inline: false },
    { name: "監査ログ上の理由", value: safeText(reasonText, defaultReasonText), inline: false },
    {
      name: "状態",
      value: buildDetecterStatusDisplayText(event, { DETECTER_DEFAULT_REASON_TEXT: defaultReasonText }).slice(0, 1024),
      inline: false,
    },
  ];
  if (event.punishmentType === "timeout") {
    fields.push({
      name: "タイムアウト終了日時",
      value: fmtDt(new Date(event.timeoutEnd * 1000)),
      inline: false,
    });
  }
  return fields;
}

export function buildReasonPromptCard(
  event: PunishmentEvent,
  reasonText: string,
  defaultReasonText: string,
  leadingNotice?: string,
): ComponentCardBuilder {
  const baseDesc = "下のボタンからモーダルを開き、処罰理由を入力してください。";
  return new ComponentCardBuilder()
    .setTitle("処罰理由の入力が必要です")
    .setDescription(leadingNotice ? `${leadingNotice}\n\n${baseDesc}` : baseDesc)
    .setTimestamp(new Date())
    .addFields(buildPunishmentCommonFields(event, reasonText, defaultReasonText))
    .setFooter({ text: `event_id=${event.eventId}` });
}

export function buildAuditReasonLoggedCard(
  event: PunishmentEvent,
  defaultReasonText: string,
): ComponentCardBuilder {
  const notice = `<@${event.actorUserId}>さん。<@${event.targetUserId}> への処罰について、監査ログに理由が記録されています。`;
  const detail = "監査ログに理由が入力されているため、理由入力ボタンは表示していません。対象ユーザーへ異議申し立て案内を送信しました。";
  return new ComponentCardBuilder()
    .setTitle("処罰の記録（監査ログに理由あり）")
    .setDescription(`${notice}\n\n${detail}`)
    .setTimestamp(new Date())
    .addFields(buildPunishmentCommonFields(event, event.detectedReason, defaultReasonText))
    .setFooter({ text: `event_id=${event.eventId}` });
}

export function buildTargetPunishmentDmCard(
  event: PunishmentEvent,
  reason: string,
  defaultReasonText: string,
  appealUrl?: string,
): ComponentCardBuilder {
  const card = new ComponentCardBuilder()
    .setTitle("処罰通知")
    .setDescription("下のボタンから異議申し立てを送信できます。")
    .setTimestamp(new Date())
    .addFields(
      { name: "サーバー", value: `${event.guildName} (${event.guildId})`, inline: false },
      { name: "処罰種別", value: formatPunishmentType(event.punishmentType), inline: false },
      { name: "理由", value: safeText(reason, defaultReasonText), inline: false },
    );
  if (appealUrl) {
    card.addFields({ name: "案内", value: appealUrl.slice(0, 1000), inline: false });
  }
  card.addFields({
    name: event.punishmentType === "timeout" ? "タイムアウト終了日時" : "異議申し立て期限",
    value: fmtDt(new Date(event.timeoutEnd * 1000)),
    inline: false,
  });
  return card;
}

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { ComponentCardBuilder } from "../../core/componentCard.js";
import { ROLE_THREAD_LABELS, type WerewolfState, type WerewolfThreadRole } from "./werewolfState.js";

export const WEREWOLF_BUTTON_PREFIX = "ww:";
export const WEREWOLF_SELECT_PREFIX = "wws:";

export function formatMentions(userIds: string[]): string {
  return userIds.map((id) => `<@${id}>`).join(", ");
}

export function truncateSelectLabel(value: string): string {
  const normalized = value.trim() || "Unknown";
  return normalized.length > 100 ? normalized.slice(0, 100) : normalized;
}

export function buildLobbyRows(sessionId: string, disabled: boolean): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${WEREWOLF_BUTTON_PREFIX}join:${sessionId}`).setLabel("参加").setStyle(ButtonStyle.Success).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`${WEREWOLF_BUTTON_PREFIX}leave:${sessionId}`).setLabel("退出").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`${WEREWOLF_BUTTON_PREFIX}start:${sessionId}`).setLabel("開始").setStyle(ButtonStyle.Primary).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`${WEREWOLF_BUTTON_PREFIX}cancel:${sessionId}`).setLabel("中止").setStyle(ButtonStyle.Danger).setDisabled(disabled),
    ),
  ];
}

export function werewolfCard(title: string, description: string): ComponentCardBuilder {
  return new ComponentCardBuilder()
    .setTitle(title)
    .setDescription(description.slice(0, 4096) || "\u200b");
}

export function statusCard(description: string): ComponentCardBuilder {
  return werewolfCard("人狼", description);
}

export function errorCard(description: string): ComponentCardBuilder {
  return werewolfCard("人狼エラー", description);
}

export function lobbyCard(state: WerewolfState, disabled: boolean): ComponentCardBuilder {
  return werewolfCard(
    disabled ? "人狼募集終了" : "人狼募集中",
    `参加者 (${state.participants.length}): ${state.participants.length ? formatMentions(state.participants) : "なし"}`,
  );
}

export function buildRoleThreadIntro(role: WerewolfThreadRole, members: string[]): string {
  const base = `あなたの役職は ${ROLE_THREAD_LABELS[role]} です。`;
  if (role === "werewolf") return `${base}\nこのスレッドで夜の相談と襲撃対象の選択を行ってください。\n対象: ${formatMentions(members)}`;
  if (role === "seer") return `${base}\nこのスレッドで占い対象を選択してください。`;
  return `${base}\nこのスレッドで護衛対象を選択してください。`;
}

export function nightPrompt(role: WerewolfThreadRole): string {
  if (role === "werewolf") return "襲撃対象を選択してください。";
  if (role === "seer") return "占い対象を選択してください。";
  return "護衛対象を選択してください。";
}

export function nightPlaceholder(role: WerewolfThreadRole): string {
  if (role === "werewolf") return "襲撃対象";
  if (role === "seer") return "占い対象";
  return "護衛対象";
}

export function buildDawnMessage(deaths: string[]): string {
  return deaths.length === 0
    ? "夜が明けました。死亡者はいません。"
    : `夜が明けました。死亡者: ${formatMentions(deaths)}`;
}

export function buildVoteResultMessage(executed: string | null): string {
  return executed
    ? `投票結果: ${formatMentions([executed])} が処刑されました。`
    : "投票結果: 同票または無投票のため処刑なしです。";
}

function isThreadRole(value: unknown): value is WerewolfThreadRole {
  return value === "werewolf" || value === "seer" || value === "knight";
}

export function parseWerewolfButtonId(customId: string): { action: string; sessionId: string } | null {
  const parts = customId.split(":");
  if (parts.length !== 3 || parts[0] !== "ww") return null;
  return { action: parts[1]!, sessionId: parts[2]! };
}

export function parseWerewolfSelectId(
  customId: string,
): { action: string; role: WerewolfThreadRole | null; sessionId: string } | null {
  const parts = customId.split(":");
  if (parts[0] !== "wws") return null;
  if (parts[1] === "vote" && parts[2]) return { action: "vote", role: null, sessionId: parts[2] };
  if (parts[1] === "night" && isThreadRole(parts[2]) && parts[3]) {
    return { action: "night", role: parts[2], sessionId: parts[3] };
  }
  return null;
}

import { MessageFlags, type ButtonInteraction, type Message } from "discord.js";
import { sendOrReconnectAiHistoryAdminPanel } from "./aiHistoryAdminPanel.js";
import { AiQueryService, HISTORY_CLEAR_Q_PREFIX, SHOW_PROMPT_APPLY_BUTTON_ID, safeStrip, type AiQueryServiceDeps } from "./aiQueryService.js";

// AI 会話の Discord 入口 (メンション監視・履歴クリア・プロンプト適用)。

export async function handleAiChatMonitorMessage(message: Message, ctx: AiQueryServiceDeps): Promise<boolean> {
  if (!ctx.config.CHAT_MONITOR_ENABLED) return false;
  if (message.author.bot || !message.guild || message.guildId !== ctx.config.GUILD_ID) return false;
  const botId = ctx.client.user?.id;
  if (!botId) return false;

  const mentioned = message.mentions.users.has(botId);
  let repliedToBot = false;
  if (message.reference?.messageId) {
    repliedToBot = await message.channel.messages
      .fetch(message.reference.messageId)
      .then((m) => m.author?.id === botId)
      .catch(() => false);
  }
  if (!mentioned && !repliedToBot) return false;

  const content = safeStrip(message.content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim());
  if (!content) return false;

  try {
    const svc = new AiQueryService(ctx);
    await svc.routeMonitorMessage(message, content);
  } catch (e) {
    ctx.log.warn({ err: e }, "chat monitor reply failed");
  }
  return true;
}

export async function handleAiHistoryClearButton(interaction: ButtonInteraction, ctx: AiQueryServiceDeps): Promise<boolean> {
  if (!interaction.customId.startsWith(HISTORY_CLEAR_Q_PREFIX)) return false;
  const parts = interaction.customId.slice(HISTORY_CLEAR_Q_PREFIX.length).split(":");
  if (parts.length !== 2) return false;
  const [guildId, ownerId] = parts;
  if (!/^\d+$/.test(guildId) || !/^\d+$/.test(ownerId)) return false;

  if (interaction.user.id !== ownerId) {
    await interaction.reply({ content: "この履歴は /q 実行ユーザーのみ削除できます。", flags: MessageFlags.Ephemeral });
    return true;
  }
  if (interaction.guildId !== guildId) {
    await interaction.reply({ content: "このボタンは別サーバー用です。", flags: MessageFlags.Ephemeral });
    return true;
  }

  const svc = new AiQueryService(ctx);
  await svc.clearHistory(guildId, ownerId);
  void sendOrReconnectAiHistoryAdminPanel(ctx).catch(() => undefined);
  await interaction.reply({ content: "あなたの会話履歴を削除しました。", flags: MessageFlags.Ephemeral });
  return true;
}

export async function handleShowPromptApplyButton(interaction: ButtonInteraction, ctx: AiQueryServiceDeps): Promise<boolean> {
  if (interaction.customId !== SHOW_PROMPT_APPLY_BUTTON_ID) return false;
  const embed = interaction.message.embeds[0];
  const prompt = safeStrip(embed?.description ?? "");
  if (!prompt || prompt === "プロンプトが空です。") {
    await interaction.reply({ content: "適用できるプロンプトが見つかりません。", flags: MessageFlags.Ephemeral });
    return true;
  }
  if (embed?.footer?.text?.includes("一部のみ表示")) {
    await interaction.reply({
      content: "このプロンプトは表示上限で省略されているため適用できません。",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const svc = new AiQueryService(ctx);
  svc.replaceUserPromptFromChangePromptCommand(interaction.user.id, interaction.user.username, prompt);
  await interaction.reply({ content: "このプロンプトをあなたの /q に適用しました。", flags: MessageFlags.Ephemeral });
  return true;
}

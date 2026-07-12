import { ComponentType, MessageFlags, type ButtonInteraction } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { buildVxTwitterPreviewPayload, buildVxTwitterReplyPayloads, parseXStatusUrl, VX_PREVIEW_SHOW_ORIGINAL_ID, VX_PREVIEW_SHOW_TRANSLATION_ID, type VxTwitterPreviewPayload } from "./vxtwitterPreview.js";
import { getVxTwitterPreviewState, saveVxTwitterPreviewState } from "./vxtwitterPreviewState.js";

const locks = new Map<string, Promise<void>>();

function toggleMode(id: string): "original" | "translation" | null {
  if (id === VX_PREVIEW_SHOW_ORIGINAL_ID) return "original";
  if (id === VX_PREVIEW_SHOW_TRANSLATION_ID) return "translation";
  return null;
}

function xLinkFromMessage(interaction: ButtonInteraction): string | null {
  const inspect = (components: readonly { type: ComponentType; components?: readonly any[]; label?: string; url?: string }[]): string | null => {
    for (const component of components) {
      if (component.type === ComponentType.Button && component.label === "Xで開く" && component.url) return component.url;
      if (component.components) {
        const nested = inspect(component.components);
        if (nested) return nested;
      }
    }
    return null;
  };
  return inspect(interaction.message.components as never);
}

async function serialized(messageId: string, task: () => Promise<void>): Promise<void> {
  const previous = locks.get(messageId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  locks.set(messageId, current);
  try { await current; } finally { if (locks.get(messageId) === current) locks.delete(messageId); }
}

export async function handleVxTwitterPreviewButton(interaction: ButtonInteraction, ctx: BotContext): Promise<boolean> {
  const mode = toggleMode(interaction.customId);
  if (!mode) return false;
  const guildId = interaction.guildId;
  const channelId = interaction.channelId;
  if (!guildId || !channelId || guildId !== ctx.config.GUILD_ID || interaction.message.author.id !== ctx.client.user?.id) return false;
  await interaction.deferUpdate();
  await serialized(interaction.message.id, async () => {
    const cached = await getVxTwitterPreviewState(ctx.db, interaction.message.id);
    if (cached && cached.guildId === guildId && cached.channelId === channelId) {
      await interaction.editReply(buildVxTwitterPreviewPayload(cached.tweet, "", cached.translations, mode));
      return;
    }
    const tweetUrl = xLinkFromMessage(interaction);
    if (!tweetUrl) {
      await interaction.followUp({ content: "投稿を再取得できないため、表示を切り替えられませんでした。", flags: MessageFlags.Ephemeral });
      return;
    }
    if (!parseXStatusUrl(tweetUrl)) {
      await interaction.followUp({ content: "投稿URLを検証できないため、表示を切り替えられませんでした。", flags: MessageFlags.Ephemeral });
      return;
    }
    const refreshed = await buildVxTwitterReplyPayloads([tweetUrl], {
      config: ctx.config, log: ctx.log, aiRouter: ctx.aiRouter, guildId,
    });
    const preview = refreshed[0] as VxTwitterPreviewPayload | undefined;
    if (!preview?.previewState) {
      await interaction.followUp({ content: "投稿を再取得できないため、表示を切り替えられませんでした。", flags: MessageFlags.Ephemeral });
      return;
    }
    await saveVxTwitterPreviewState(ctx.db, {
      messageId: interaction.message.id, guildId, channelId,
      tweetUrl: preview.previewState.tweet.url, ...preview.previewState,
    });
    await interaction.editReply(buildVxTwitterPreviewPayload(preview.previewState.tweet, "", preview.previewState.translations, mode));
  }).catch(async (err) => {
    ctx.log.warn({ err: String(err), messageId: interaction.message.id }, "vxtwitter preview toggle failed");
    await interaction.followUp({ content: "表示の切り替えに失敗しました。しばらくしてからお試しください。", flags: MessageFlags.Ephemeral }).catch(() => undefined);
  });
  return true;
}

import { MessageFlags, type ButtonInteraction } from "discord.js";
import type { CoreDeps } from "../../../core/deps.js";
import {
  patchPreviewTextComponents,
  PREVIEW_SHOW_ORIGINAL_ID,
  PREVIEW_SHOW_TRANSLATION_ID,
  type PreviewDisplayMode,
} from "./previewRenderer.js";
import {
  getPreviewTranslationState,
  savePreviewTranslationState,
  type PreviewTranslationState,
  type PreviewTranslationStateV1,
} from "./previewState.repository.js";

const LEGACY_SHOW_ORIGINAL_ID = "vxpreview:show-original";
const LEGACY_SHOW_TRANSLATION_ID = "vxpreview:show-translation";
const locks = new Map<string, Promise<unknown>>();

type PreviewInteractionDeps = {
  getState?: (messageId: string) => Promise<PreviewTranslationState | null>;
  refreshState?: (input: {
    message: Awaited<ReturnType<ButtonInteraction["message"]["fetch"]>>;
    guildId: string;
    channelId: string;
  }) => Promise<PreviewTranslationStateV1 | null>;
  saveState?: typeof savePreviewTranslationState;
};

export function previewToggleMode(id: string): PreviewDisplayMode | null {
  if (id === PREVIEW_SHOW_ORIGINAL_ID || id === LEGACY_SHOW_ORIGINAL_ID) return "original";
  if (id === PREVIEW_SHOW_TRANSLATION_ID || id === LEGACY_SHOW_TRANSLATION_ID) return "translation";
  return null;
}

function isLegacyToggleId(id: string): boolean {
  return id === LEGACY_SHOW_ORIGINAL_ID || id === LEGACY_SHOW_TRANSLATION_ID;
}

async function serialized<T>(messageId: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(messageId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  locks.set(messageId, current);
  try {
    return await current;
  } finally {
    if (locks.get(messageId) === current) locks.delete(messageId);
  }
}

function normalizeLegacyToggleComponents(components: readonly unknown[]): unknown[] {
  const next = structuredClone(components) as Array<Record<string, unknown>>;
  const visit = (component: Record<string, unknown>): void => {
    if (component.custom_id === LEGACY_SHOW_ORIGINAL_ID) component.custom_id = PREVIEW_SHOW_ORIGINAL_ID;
    if (component.custom_id === LEGACY_SHOW_TRANSLATION_ID) component.custom_id = PREVIEW_SHOW_TRANSLATION_ID;
    if (Array.isArray(component.components)) {
      for (const child of component.components) {
        if (child && typeof child === "object") visit(child as Record<string, unknown>);
      }
    }
  };
  for (const component of next) visit(component);
  return next;
}

async function explainMissingState(interaction: ButtonInteraction): Promise<void> {
  const payload = {
    content: "保存されたプレビュー情報が見つからないため、表示を切り替えられませんでした。",
    flags: MessageFlags.Ephemeral,
  } as const;
  if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
  else await interaction.reply(payload);
}

async function reportFailure(interaction: ButtonInteraction): Promise<void> {
  const payload = {
    content: "表示の切り替えに失敗しました。しばらくしてからお試しください。",
    flags: MessageFlags.Ephemeral,
  } as const;
  if (!interaction.deferred && !interaction.replied) {
    const replied = await interaction.reply(payload).then(() => true).catch(() => false);
    if (replied) return;
  }
  await interaction.followUp(payload).catch(() => undefined);
}

export async function handlePreviewInteraction(
  interaction: ButtonInteraction,
  ctx: Pick<CoreDeps, "config" | "db" | "log" | "client">,
  deps: PreviewInteractionDeps = {},
): Promise<boolean> {
  const mode = previewToggleMode(interaction.customId);
  if (!mode) return false;
  const guildId = interaction.guildId;
  const channelId = interaction.channelId;
  if (
    !guildId
    || !channelId
    || guildId !== ctx.config.GUILD_ID
    || interaction.message.author.id !== ctx.client.user?.id
  ) return false;

  const legacyId = isLegacyToggleId(interaction.customId);
  try {
    if (!legacyId) await interaction.deferUpdate();
    return await serialized(interaction.message.id, async () => {
      let cached = await (deps.getState
        ? deps.getState(interaction.message.id)
        : getPreviewTranslationState(ctx.db, interaction.message.id, { log: ctx.log }));
      if (!cached || cached.version === 0) {
        if (legacyId) return false;
        if (!deps.refreshState) {
          await explainMissingState(interaction);
          return true;
        }
        const latestMessage = await interaction.message.fetch(true);
        const refreshed = await deps.refreshState({ message: latestMessage, guildId, channelId });
        if (!refreshed || refreshed.guildId !== guildId || refreshed.channelId !== channelId) {
          await explainMissingState(interaction);
          return true;
        }
        await (deps.saveState ?? savePreviewTranslationState)(ctx.db, refreshed);
        cached = refreshed;
        const latestComponents = latestMessage.components.map((component) => component.toJSON());
        const components = patchPreviewTextComponents(
          normalizeLegacyToggleComponents(latestComponents),
          cached.document,
          cached.translations,
          mode,
        );
        await interaction.editReply({ components });
        return true;
      }
      if (cached.guildId !== guildId || cached.channelId !== channelId) {
        if (legacyId) return false;
        await explainMissingState(interaction);
        return true;
      }

      if (legacyId) await interaction.deferUpdate();
      const latestMessage = await interaction.message.fetch(true);
      const latestComponents = latestMessage.components.map((component) => component.toJSON());
      const current = normalizeLegacyToggleComponents(latestComponents);
      const components = patchPreviewTextComponents(
        current,
        cached.document,
        cached.translations,
        mode,
      );
      await interaction.editReply({ components });
      return true;
    });
  } catch (err) {
    ctx.log.warn({ err: String(err), messageId: interaction.message.id }, "preview translation toggle failed");
    await reportFailure(interaction);
    return true;
  }
}

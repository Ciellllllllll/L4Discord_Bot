import type { BotContext } from "./context.js";
import {
  createRuntimeResourceLifecycle,
  shutdownModerationFlowRuntimes,
  type RuntimeHandlerHandle,
} from "./runtimeLifecycle.js";
import { createLinkPreviewRuntime } from "./linkPreviewRuntime.js";
import { registerClientReadyHandler } from "./clientReadyHandler.js";
import { registerClientEventHandlers } from "./clientEventHandlers.js";

export type { RuntimeHandlerHandle } from "./runtimeLifecycle.js";
export {
  createRuntimeShutdown,
  createRuntimeResourceLifecycle,
  shutdownModerationFlowRuntimes,
} from "./runtimeLifecycle.js";
export {
  shouldStartYouTubeVideoCacheMaintenance,
  startPreviewStateCleanup,
  startClientReadyBackgroundServices,
  initializeJapaneseRuntime,
} from "./clientReadyServices.js";
export { respondToInteractionError } from "./interactionErrors.js";

// 起動時のハンドラ登録。

export async function registerRuntimeHandlers(ctx: BotContext): Promise<RuntimeHandlerHandle> {
  const { log, client } = ctx;
  // リンクプレビュー関連オブジェクトの生成は linkPreviewRuntime モジュール (bot 側) で行う。
  // 生成の順番と、メッセージ処理の順番・条件は utilitiesMessage にあったときと同じ。
  const utilitiesBundle = createLinkPreviewRuntime(ctx);
  const lifecycle = createRuntimeResourceLifecycle({ vcTemp: ctx.vcTemp, client, shutdownModerationFlows: async () => {
    await utilitiesBundle.expansions.stop();
    await shutdownModerationFlowRuntimes();
  } });

  registerClientReadyHandler(ctx, lifecycle, utilitiesBundle);
  await registerClientEventHandlers(ctx, lifecycle, utilitiesBundle);

  log.debug(
    {
      events: [
        "interactionCreate",
        "messageCreate",
        "messageUpdate",
        "messageDelete",
        "messageDeleteBulk",
        "messageReactionAdd",
        "voiceStateUpdate",
        "guildBanAdd",
        "guildMemberUpdate",
        "guildMemberRemove",
      ],
    },
    "discord client event listeners registered",
  );

  return lifecycle;
}

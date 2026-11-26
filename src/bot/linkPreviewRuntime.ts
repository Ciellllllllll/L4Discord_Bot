import type { BotContext } from "./context.js";
import { createUtilitiesMessageHandlers, type UtilitiesMessageBundle } from "../features/utilities/utilitiesMessage.js";
import { LinkExpansionRepository } from "../features/linkPreviews/shared/linkExpansionRepository.js";
import { LinkExpansionTracker } from "../features/linkPreviews/shared/linkExpansionTracker.js";
import { LinkPreviewMessageHandler } from "../features/linkPreviews/linkPreviewMessageHandler.js";

// リンクプレビュー関連オブジェクトの組み立て。生成の順番と、
// utilitiesMessage の遅延参照 (utilitiesBundle) の意味は registerRuntimeHandlers にあったときと同じ。
export function createLinkPreviewRuntime(ctx: BotContext): UtilitiesMessageBundle {
  const linkRepository = new LinkExpansionRepository(ctx.mainPgPool, () => {
    if (!ctx.client.user) throw new Error("Discord client is not ready");
    return ctx.client.user.id;
  });
  const linkExpansions = new LinkExpansionTracker(ctx, linkRepository, async (message) => {
    const results = await Promise.allSettled([
      utilitiesBundle.linkPreview.onMessage(message), utilitiesBundle.leaveNotifierMessages.onMessage(message),
    ]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }, (message) => utilitiesBundle.linkPreview.releaseEmbeds(message));
  const linkPreviewHandler = new LinkPreviewMessageHandler(ctx, { replyExpansion: linkExpansions.reply, deferExpansion: linkExpansions.defer });
  const utilitiesBundle = createUtilitiesMessageHandlers(ctx, { expansions: linkExpansions, linkPreview: linkPreviewHandler });
  return utilitiesBundle;
}

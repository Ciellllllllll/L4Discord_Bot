import type { IVcRankingRepository } from "../adapters/legacyDb/vcRankingRepository.js";
import type { VcTemporaryChannelManager } from "../features/vc/vcTemporaryChannelManager.js";
import type { AiProviderRouter } from "../features/ai/aiProviderRouter.js";
import type { CancelPendingModmailReplies } from "../features/appeals/appealHandlers.js";
import type { CoreDeps } from "../core/deps.js";

// BotContext は最下層の依存 (CoreDeps) に、機能固有の実装を組み立て時に足した型。
export type BotContext = CoreDeps & {
  aiRouter: AiProviderRouter;
  vcRanking: IVcRankingRepository;
  vcTemp: VcTemporaryChannelManager;
  /** 異議申し立ての解決時に、modmail 側の保留返信をキャンセルする実装 */
  cancelPendingModmailReplies: CancelPendingModmailReplies;
};

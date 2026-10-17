import type { Message, PartialMessage } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { CatApiResponder } from "./catApiResponder.js";
import { DogApiResponder } from "./dogApiResponder.js";
import { KeywordResponder } from "./keywordResponder.js";
import { LeaveNotifierMessageHandler } from "./leaveNotifier.js";
import { ColdLaughHandler } from "./coldLaugh.js";
import { LinkPreviewMessageHandler } from "../linkPreviews/linkPreviewMessageHandler.js";
import { LinkExpansionTracker } from "../linkPreviews/shared/linkExpansionTracker.js";
import { LinkExpansionRepository } from "../linkPreviews/shared/linkExpansionRepository.js";

export type UtilitiesMessageBundle = {
  log: Pick<BotContext["log"], "warn">;
  expansions: LinkExpansionTracker;
  coldLaugh: ColdLaughHandler;
  linkPreview: LinkPreviewMessageHandler;
  catApiResponder: CatApiResponder;
  dogApiResponder: DogApiResponder;
  keywordResponder: KeywordResponder;
  leaveNotifierMessages: LeaveNotifierMessageHandler;
};

export function createUtilitiesMessageHandlers(ctx: BotContext): UtilitiesMessageBundle {
  const repository = new LinkExpansionRepository(ctx.mainPgPool, () => {
    if (!ctx.client.user) throw new Error("Discord client is not ready");
    return ctx.client.user.id;
  });
  const expansions = new LinkExpansionTracker(ctx, repository, async (message) => {
    const results = await Promise.allSettled([
      bundle.linkPreview.onMessage(message), bundle.leaveNotifierMessages.onMessage(message),
    ]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  });
  const bundle: UtilitiesMessageBundle = {
    log: ctx.log,
    expansions,
    coldLaugh: new ColdLaughHandler(ctx),
    linkPreview: new LinkPreviewMessageHandler(ctx, { replyExpansion: expansions.reply, deferExpansion: expansions.defer }),
    catApiResponder: new CatApiResponder(ctx),
    dogApiResponder: new DogApiResponder(ctx),
    keywordResponder: new KeywordResponder(ctx),
    leaveNotifierMessages: new LeaveNotifierMessageHandler(ctx, expansions.reply),
  };
  return bundle;
}

/** 追跡中の展開を更新し、リンクを持たなかった投稿が編集でリンクを得た場合は新たに展開する。 */
export async function runUtilitiesMessageUpdate(
  bundle: UtilitiesMessageBundle,
  oldMessage: Message | PartialMessage,
  newMessage: Message | PartialMessage,
): Promise<void> {
  await bundle.expansions.onUpdate(newMessage).catch((error) => {
    bundle.log.warn({ err: String(error), messageId: newMessage.id }, "link expansion update failed");
  });
  // 埋め込みの解決だけで届く更新は、本文が同じなので新規展開の対象にしない。
  if (oldMessage.content != null && oldMessage.content === newMessage.content) return;
  try {
    const message = newMessage.partial ? await newMessage.fetch() : newMessage;
    if (!message.content) return;
    if (!bundle.linkPreview.hasLinks(message) && !bundle.leaveNotifierMessages.hasLinks(message)) return;
    await bundle.expansions.onUntrackedUpdate(message);
  } catch (error) {
    bundle.log.warn({ err: String(error), messageId: newMessage.id }, "link expansion for edited message failed");
  }
}

export async function runUtilitiesMessageChain(bundle: UtilitiesMessageBundle, message: Message): Promise<void> {
  await bundle.coldLaugh.onMessage(message);
  // 動画キューや外部APIの待ちで、後続のモデレーション処理を止めない。
  if (bundle.linkPreview.hasLinks(message) || bundle.leaveNotifierMessages.hasLinks(message)) {
    void bundle.expansions.onCreate(message).catch((error) => {
      bundle.log.warn({ err: String(error), messageId: message.id }, "link expansion failed");
    });
  }
  await bundle.catApiResponder.onMessage(message);
  await bundle.dogApiResponder.onMessage(message);
  await bundle.keywordResponder.onMessage(message);
}

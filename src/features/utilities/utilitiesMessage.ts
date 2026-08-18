import type { Message } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { CatApiResponder } from "./catApiResponder.js";
import { DogApiResponder } from "./dogApiResponder.js";
import { KeywordResponder } from "./keywordResponder.js";
import { LeaveNotifierMessageHandler } from "./leaveNotifier.js";
import { ColdLaughHandler } from "./coldLaugh.js";
import { LinkPreviewMessageHandler } from "../linkPreviews/linkPreviewMessageHandler.js";

export type UtilitiesMessageBundle = {
  coldLaugh: ColdLaughHandler;
  linkPreview: LinkPreviewMessageHandler;
  catApiResponder: CatApiResponder;
  dogApiResponder: DogApiResponder;
  keywordResponder: KeywordResponder;
  leaveNotifierMessages: LeaveNotifierMessageHandler;
};

export function createUtilitiesMessageHandlers(ctx: BotContext): UtilitiesMessageBundle {
  return {
    coldLaugh: new ColdLaughHandler(ctx),
    linkPreview: new LinkPreviewMessageHandler(ctx),
    catApiResponder: new CatApiResponder(ctx),
    dogApiResponder: new DogApiResponder(ctx),
    keywordResponder: new KeywordResponder(ctx),
    leaveNotifierMessages: new LeaveNotifierMessageHandler(ctx),
  };
}

// DiscordBOTv2 `Utilities.js` setup() と同じ順序（Cold laugh → Link → Keyword → Leave）

export async function runUtilitiesMessageChain(bundle: UtilitiesMessageBundle, message: Message): Promise<void> {
  await bundle.coldLaugh.onMessage(message);
  await bundle.linkPreview.onMessage(message);
  await bundle.catApiResponder.onMessage(message);
  await bundle.dogApiResponder.onMessage(message);
  await bundle.keywordResponder.onMessage(message);
  await bundle.leaveNotifierMessages.onMessage(message);
}

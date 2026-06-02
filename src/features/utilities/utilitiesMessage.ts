import type { Message } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { CatApiResponder } from "./catApiResponder.js";
import { DogApiResponder } from "./dogApiResponder.js";
import { KeywordResponder } from "./keywordResponder.js";
import { LeaveNotifierMessageHandler } from "./leaveNotifier.js";
import { LinkAndColdLaugh } from "./linkAndColdLaugh.js";

export type UtilitiesMessageBundle = {
  linkAndColdLaugh: LinkAndColdLaugh;
  catApiResponder: CatApiResponder;
  dogApiResponder: DogApiResponder;
  keywordResponder: KeywordResponder;
  leaveNotifierMessages: LeaveNotifierMessageHandler;
};

export function createUtilitiesMessageHandlers(ctx: BotContext): UtilitiesMessageBundle {
  return {
    linkAndColdLaugh: new LinkAndColdLaugh(ctx),
    catApiResponder: new CatApiResponder(ctx),
    dogApiResponder: new DogApiResponder(ctx),
    keywordResponder: new KeywordResponder(ctx),
    leaveNotifierMessages: new LeaveNotifierMessageHandler(ctx),
  };
}

// DiscordBOTv2 `Utilities.js` setup() と同じ順序（Link → Keyword → Leave の onMessage）

export async function runUtilitiesMessageChain(bundle: UtilitiesMessageBundle, message: Message): Promise<void> {
  await bundle.linkAndColdLaugh.onMessage(message);
  await bundle.catApiResponder.onMessage(message);
  await bundle.dogApiResponder.onMessage(message);
  await bundle.keywordResponder.onMessage(message);
  await bundle.leaveNotifierMessages.onMessage(message);
}

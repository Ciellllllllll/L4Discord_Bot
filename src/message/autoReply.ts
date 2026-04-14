import type { Message } from "discord.js";
import type { BotContext } from "../bot/context.js";

// 旧: X/Twitter URL → vxtwitter 変換は `features/utilities/linkAndColdLaugh.ts`（DiscordBOTv2 Utilities）へ移行済み。

export async function handleAutoReply(_message: Message, _ctx: BotContext): Promise<boolean> {
  return false;
}

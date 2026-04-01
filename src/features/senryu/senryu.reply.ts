import type { Message } from "discord.js";
import type { SenryuCandidate } from "./senryu.types.js";

export async function replySenryu(
  message: Message,
  candidate: SenryuCandidate,
  spoiler: boolean,
): Promise<void> {
  const lines = spoiler
    ? [`川柳を検出しました！`, `||「${candidate.formatted}」||`]
    : [`川柳を検出しました！`, `「${candidate.formatted}」`];
  await message.reply({ content: lines.join("\n"), allowedMentions: { parse: [] } });
}

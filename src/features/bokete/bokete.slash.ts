import { AttachmentBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { ComponentCardBuilder, componentCardsPayload } from "../panels/componentCard.js";
import { fetchBoketePost, type FetchBoketePostOptions } from "./boketeClient.js";

const FETCH_FAILED_MESSAGE = "投稿の取得に失敗しました。しばらくしてから再度お試しください。";
export const BOKETE_THREAD_ID = "1530637445765398578";
const RESTRICTED_CHANNEL_MESSAGE = "このコマンドは指定スレッドでのみ利用できます。";

export async function handleBoketeSlash(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  options: Pick<FetchBoketePostOptions, "fetcher"> = {},
): Promise<void> {
  if (interaction.channelId !== BOKETE_THREAD_ID) {
    await interaction.reply({ content: RESTRICTED_CHANNEL_MESSAGE, flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply();
  try {
    const result = await fetchBoketePost({
      baseUrl: ctx.config.BOKETE_API_BASE_URL,
      requestTimeoutMs: ctx.config.BOKETE_REQUEST_TIMEOUT_MS,
      ...options,
    });
    if (result.kind === "empty") {
      await interaction.editReply(componentCardsPayload([
        new ComponentCardBuilder()
          .setTitle("Bokete")
          .setDescription("現在利用できる投稿がありません"),
      ]));
      return;
    }

    const description = result.text.length > 3_997 ? `${result.text.slice(0, 3_994)}...` : result.text;
    const card = new ComponentCardBuilder()
      .setImage(`attachment://${result.filename}`)
      .addBottomTextDisplays(`# ${description}`, "Bokete API by Ciel");
    await interaction.editReply({
      ...componentCardsPayload([card]),
      files: [new AttachmentBuilder(result.image, { name: result.filename })],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    ctx.log.warn({ err: error }, "Bokete command failed");
    await interaction.editReply(componentCardsPayload([
      new ComponentCardBuilder()
        .setTitle("Bokete")
        .setDescription(FETCH_FAILED_MESSAGE),
    ]));
  }
}

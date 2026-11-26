import { MessageFlags, type RepliableInteraction } from "discord.js";

// interaction 失敗時の応答。

const DISCORD_UNKNOWN_INTERACTION = 10062;

function isUnknownInteractionError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === DISCORD_UNKNOWN_INTERACTION;
}

export async function respondToInteractionError(
  interaction: RepliableInteraction,
  onFailure: (error: unknown, method: "reply" | "editReply" | "followUp") => void = () => undefined,
): Promise<void> {
  const content = "エラーが発生しました。";
  // 応答期限切れ（Unknown interaction）の後は、同じinteractionへの送信がすべて失敗する。
  let expired = false;
  const handleFailure = (error: unknown, method: "reply" | "editReply") => {
    onFailure(error, method);
    if (isUnknownInteractionError(error)) expired = true;
    return false;
  };
  if (!interaction.replied && !interaction.deferred) {
    const replied = await interaction.reply({ content, flags: MessageFlags.Ephemeral })
      .then(() => true)
      .catch((error) => handleFailure(error, "reply"));
    if (replied || expired) return;
  }
  if (interaction.deferred && !interaction.replied) {
    const edited = await interaction.editReply({ content })
      .then(() => true)
      .catch((error) => handleFailure(error, "editReply"));
    if (edited || expired) return;
  }
  await interaction.followUp({ content, flags: MessageFlags.Ephemeral })
    .catch((error) => { onFailure(error, "followUp"); });
}

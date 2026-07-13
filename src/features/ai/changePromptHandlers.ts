import { MessageFlags, type Attachment, type ModalSubmitInteraction } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { AiQueryService } from "./aiQueryService.js";
import { CHANGE_PROMPT_FILE_ID, CHANGE_PROMPT_MODAL_ID, CHANGE_PROMPT_TEXT_ID } from "./changePromptIds.js";
import { readResponseArrayBufferWithLimit } from "./fetchWithLimits.js";

// モーダル経由のプロンプト用テキスト添付の最大バイト（本文のみ）

const MAX_PROMPT_ATTACHMENT_BYTES = 1 * 1024 * 1024;

function isTxtOrMdFilename(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n.endsWith(".txt") || n.endsWith(".md");
}

async function fetchAttachmentAsUtf8(att: Attachment, log: BotContext["log"]): Promise<string | null> {
  if (att.size > MAX_PROMPT_ATTACHMENT_BYTES) {
    log.warn({ size: att.size }, "change_prompt attachment too large");
    return null;
  }
  try {
    const res = await fetch(att.url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      log.warn({ status: res.status }, "change_prompt attachment fetch failed");
      return null;
    }
    const contentLength = Number(res.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_PROMPT_ATTACHMENT_BYTES) {
      log.warn({ size: contentLength }, "change_prompt attachment too large");
      return null;
    }
    const buf = Buffer.from(await readResponseArrayBufferWithLimit(res, MAX_PROMPT_ATTACHMENT_BYTES));
    if (buf.byteLength === 0) return "";
    return buf.toString("utf8");
  } catch (e) {
    log.warn({ err: String(e) }, "change_prompt attachment fetch error");
    return null;
  }
}

// `/change_prompt` モーダル送信。
// @returns 処理した場合 true（未該当 customId は false）

export async function handleChangePromptModalSubmit(
  interaction: ModalSubmitInteraction,
  ctx: BotContext,
): Promise<boolean> {
  if (interaction.customId !== CHANGE_PROMPT_MODAL_ID) {
    return false;
  }

  if (!interaction.inGuild() || interaction.guildId !== ctx.config.GUILD_ID) {
    await interaction.reply({ content: "このサーバーでは利用できません。", flags: MessageFlags.Ephemeral }).catch(() => undefined);
    return true;
  }

  const textRaw = interaction.fields.getTextInputValue(CHANGE_PROMPT_TEXT_ID) ?? "";
  const textTrim = textRaw.trim();

  let uploaded: ReadonlyMap<string, Attachment> | null = null;
  try {
    uploaded = interaction.fields.getUploadedFiles(CHANGE_PROMPT_FILE_ID, false);
  } catch {
    uploaded = null;
  }

  const attachments = uploaded && uploaded.size > 0 ? [...uploaded.values()] : [];
  // maxValues(1) だが、将来の API 変化に備え先頭1件のみ採用する（複数は無視）
  const firstAtt = attachments[0];

  if (firstAtt && !isTxtOrMdFilename(firstAtt.name ?? "")) {
    await interaction
      .reply({
        content: "添付できるのは拡張子が .txt または .md のファイルのみです。",
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => undefined);
    return true;
  }

  let fileTextTrim = "";
  if (firstAtt) {
    const decoded = await fetchAttachmentAsUtf8(firstAtt, ctx.log);
    if (decoded === null) {
      await interaction
        .reply({
          content: "ファイルの取得に失敗したか、サイズが大きすぎます。別のファイルで再度お試しください。",
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => undefined);
      return true;
    }
    fileTextTrim = decoded.trim();
  }

  let finalText: string;
  if (textTrim.length > 0) {
    finalText = textTrim;
  } else if (firstAtt) {
    if (!fileTextTrim) {
      await interaction
        .reply({
          content: "テキスト欄に入力するか、中身のある .txt / .md ファイルを添付してください。",
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => undefined);
      return true;
    }
    finalText = fileTextTrim;
  } else {
    await interaction
      .reply({
        content: "テキスト欄に入力するか、.txt / .md ファイルを添付してください（どちらか一方以上が必要です）。",
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => undefined);
    return true;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => undefined);
  if (!interaction.deferred && !interaction.replied) {
    return true;
  }

  try {
    const svc = new AiQueryService(ctx);
    svc.replaceUserPromptFromChangePromptCommand(interaction.user.id, interaction.user.username, finalText);
    const rel = ctx.config.USER_PROMPT_DIR;
    ctx.log.info(
      { userId: interaction.user.id, userPromptDir: rel },
      "change_prompt: user prompt file replaced",
    );
    await interaction
      .editReply({
        content: "自分用プロンプトを更新しました。次回の /q 以降から反映されます。",
      })
      .catch(() => undefined);
  } catch (e) {
    ctx.log.error({ err: e }, "change_prompt write failed");
    await interaction
      .editReply({ content: "プロンプトの保存に失敗しました。しばらくしてから再度お試しください。" })
      .catch(() => undefined);
  }

  return true;
}

import { TextInputStyle } from "discord.js";
import {
  ActionRowBuilder as IntakeActionRowBuilder,
  FileUploadBuilder,
  LabelBuilder,
  ModalBuilder as IntakeModalBuilder,
  TextInputBuilder as IntakeTextInputBuilder,
} from "@discordjs/builders";
import { CHANGE_PROMPT_FILE_ID, CHANGE_PROMPT_MODAL_ID, CHANGE_PROMPT_TEXT_ID } from "./changePromptIds.js";

// `/change_prompt` 用モーダル。
// TextInput は builders 側（discord.js との instanceof 整合のため Modmail と同パターン）。

export function buildChangePromptModal(): IntakeModalBuilder {
  return new IntakeModalBuilder()
    .setCustomId(CHANGE_PROMPT_MODAL_ID)
    .setTitle("プロンプトの変更")
    .addComponents(
      new IntakeActionRowBuilder<IntakeTextInputBuilder>().addComponents(
        new IntakeTextInputBuilder()
          .setCustomId(CHANGE_PROMPT_TEXT_ID)
          .setLabel("プロンプト本文（直接入力）")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(4000)
          .setPlaceholder("ここに書くか、下の .txt / .md ファイルのどちらか（または両方）を指定してください。"),
      ),
    )
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("プロンプトファイル（.txt / .md）")
        .setFileUploadComponent(
          new FileUploadBuilder()
            .setCustomId(CHANGE_PROMPT_FILE_ID)
            .setRequired(false)
            .setMaxValues(1),
        ),
    );
}

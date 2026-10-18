import assert from "node:assert/strict";
import { ApplicationCommandOptionType, type ButtonInteraction, type ChatInputCommandInteraction } from "discord.js";
import { createSurveyReplayInteraction, storeSlashCommand } from "./surveyCommandState.js";
import { parseAnonymousSurveySessionPayload } from "./surveyService.js";

const attachment = {
  id: "123", name: "question.png", size: 68, contentType: "image/png",
  url: "https://cdn.discordapp.com/attachments/1/2/question.png?ex=123&hm=signature",
};
const command = storeSlashCommand({
  commandName: "q", guildId: "guild", channelId: "channel", user: { id: "user" },
  options: { data: [{ name: "attachment", type: ApplicationCommandOptionType.Attachment, value: attachment.id, attachment }] },
} as unknown as ChatInputCommandInteraction);
const persisted = parseAnonymousSurveySessionPayload(JSON.stringify({ command }));
assert.ok(persisted);
const replay = createSurveyReplayInteraction({ user: { id: "user" } } as ButtonInteraction, persisted.command);
assert.deepEqual(replay.options.getAttachment("attachment", true), attachment);
assert.equal(replay.options.getAttachment("missing"), null);
assert.throws(() => replay.options.getAttachment("missing", true), /Required option missing/);
assert.equal(replay.options.getString("text"), null);
const invalid = { command: { ...command, options: [{ ...command.options[0], attachment: { ...attachment, size: -1 } }] } };
assert.equal(parseAnonymousSurveySessionPayload(invalid), null);
console.log("surveyCommandState.spec.ts: all assertions passed");

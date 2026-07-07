import assert from "node:assert/strict";
import { ApplicationCommandType } from "discord.js";
import { buildSlashCommands } from "./buildSlashCommands.js";

function chatInputCommand(name: string, botProfile?: Parameters<typeof buildSlashCommands>[0]) {
  const command = buildSlashCommands(botProfile).find((candidate) => candidate.name === name);
  if (!command || command.type === ApplicationCommandType.User || command.type === ApplicationCommandType.Message) {
    return null;
  }
  return command;
}

async function run(): Promise<void> {
  assert.equal(chatInputCommand("survey"), null);
  assert.equal(chatInputCommand("survey", "production"), null);

  const survey = chatInputCommand("survey", "debug");
  assert.ok(survey);
  assert.equal("description" in survey ? survey.description : undefined, "Anonymous Surveyを手動で表示します(DEBUG用)");
}

void run()
  .then(() => {
    console.log("buildSlashCommands.spec.ts: all assertions passed");
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

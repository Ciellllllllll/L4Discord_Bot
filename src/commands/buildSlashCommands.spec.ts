import assert from "node:assert/strict";
import { ApplicationCommandOptionType, ApplicationCommandType, PermissionFlagsBits } from "discord.js";
import { buildSlashCommands } from "./buildSlashCommands.js";

function chatInputCommand(name: string, botProfile?: Parameters<typeof buildSlashCommands>[0]) {
  const command = buildSlashCommands(botProfile).find((candidate) => candidate.name === name);
  if (!command || command.type === ApplicationCommandType.User || command.type === ApplicationCommandType.Message) {
    return null;
  }
  return command;
}

async function run(): Promise<void> {
  const q = chatInputCommand("q");
  assert.ok(q);
  assert.deepEqual(q.options?.map((option) => [option.name, option.type, option.required ?? false]), [
    ["text", ApplicationCommandOptionType.String, false],
    ["attachment", ApplicationCommandOptionType.Attachment, false],
  ]);

  assert.equal(chatInputCommand("survey"), null);
  assert.equal(chatInputCommand("survey", "production"), null);

  const survey = chatInputCommand("survey", "debug");
  assert.ok(survey);
  assert.equal("description" in survey ? survey.description : undefined, "Anonymous Surveyを手動で表示します(DEBUG用)");

  const view = chatInputCommand("view");
  assert.ok(view);
  assert.equal(view.default_member_permissions, PermissionFlagsBits.Administrator.toString());

  const adhd = chatInputCommand("adhd");
  assert.ok(adhd);
  assert.equal(adhd.default_member_permissions, PermissionFlagsBits.Administrator.toString());
  assert.deepEqual(adhd.options?.map((option) => option.name), ["add", "remove", "list", "scan_now"]);

  const bokete = chatInputCommand("bokete");
  assert.ok(bokete);
  assert.equal("description" in bokete ? bokete.description : undefined, "Boketeを1件表示します");
  assert.equal(bokete.default_member_permissions, undefined);

  const bokeru = chatInputCommand("bokeru");
  assert.ok(bokeru);
  assert.equal(bokeru.default_member_permissions, undefined);
  assert.deepEqual(bokeru.options?.map((option) => option.name), ["start", "ranking"]);

  const gif = chatInputCommand("gif");
  assert.ok(gif);
  assert.equal(gif.default_member_permissions, PermissionFlagsBits.Administrator.toString());
  assert.deepEqual(gif.options?.map((option) => option.name), ["set", "show", "clear"]);
  const set = gif.options?.find((option) => option.name === "set");
  const setOptions = set && "options" in set ? set.options ?? [] : [];
  assert.deepEqual(setOptions.map((option) => option.name), [
    "trigger_url",
    "response_url",
  ]);
  assert.deepEqual(
    setOptions.map((option) => "max_length" in option ? option.max_length : undefined),
    [900, 900],
  );
}

void run()
  .then(() => {
    console.log("buildSlashCommands.spec.ts: all assertions passed");
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

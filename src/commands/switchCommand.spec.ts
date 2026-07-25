import assert from "node:assert/strict";
import { PermissionFlagsBits } from "discord.js";
import { buildSlashCommands } from "./buildSlashCommands.js";
import { BOT_SEMVER, SLASH_COMMAND_MIN_BOT_VERSION } from "../core/releaseVersions.js";

const command = buildSlashCommands().find((candidate) => candidate.name === "switch");
assert.ok(command, "/switch must be registered");
assert.equal(command.default_member_permissions, PermissionFlagsBits.Administrator.toString());
const provider = command.options?.find((option) => option.name === "provider") as
  | { required?: boolean; choices?: Array<{ value: string | number }> }
  | undefined;
assert.equal(provider?.required, true);
assert.deepEqual(provider?.choices?.map((choice) => choice.value), [
  "openai_gpt56",
  "openai_gpt54_mini",
  "deepseek",
]);
assert.equal(BOT_SEMVER, "2.0.12");
assert.equal(SLASH_COMMAND_MIN_BOT_VERSION.switch, "2.0.10");

console.log("switchCommand.spec.ts: all assertions passed");

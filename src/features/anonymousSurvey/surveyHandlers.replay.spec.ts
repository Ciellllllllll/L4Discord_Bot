import assert from "node:assert/strict";
import type { ButtonInteraction, ChatInputCommandInteraction } from "discord.js";
import type { CoreDeps } from "../../core/deps.js";
import type { Kysely } from "kysely";
import type { Database } from "../../core/db/types.js";
import { storeSlashCommand } from "./surveyCommandState.js";
import { handleAnonymousSurveyButton } from "./surveyHandlers.js";
import { SURVEY_CONTINUE_PREFIX } from "./surveyUi.js";

// surveyHandlers は入口層から渡された関数でスラッシュコマンドを再実行する。
// 入口層 (interactions/handleComponents.ts) が handleSlashCommand を渡していることを、
// 呼び出し引数 ({ skipSurvey: true } と再生されたコマンド) で確かめる。

type AnyRow = Record<string, unknown>;

// interaction_sessions への select/delete が設定した行を返す最小限のスタブ
function fakeDb(row: AnyRow): Kysely<Database> {
  const build = () => {
    const builder: Record<string, unknown> = {
      selectAll: () => builder,
      select: () => builder,
      where: () => builder,
      returning: () => builder,
      executeTakeFirst: async () => row,
      execute: async () => undefined,
    };
    return builder;
  };
  return {
    selectFrom: () => build(),
    deleteFrom: () => build(),
  } as unknown as Kysely<Database>;
}

const command = storeSlashCommand({
  commandName: "q",
  guildId: "guild",
  channelId: "channel",
  user: { id: "user" },
  options: { data: [] },
} as unknown as ChatInputCommandInteraction);

const sessionRow: AnyRow = {
  payload: JSON.stringify({ command }),
  guild_id: "guild",
  domain: "anonymousSurvey",
  action: "continueCommand",
  executor_user_id: "user",
};

const replies: unknown[] = [];
const interaction = {
  customId: `${SURVEY_CONTINUE_PREFIX}session-1`,
  user: { id: "user" },
  reply: async (payload: unknown) => {
    replies.push(payload);
  },
} as unknown as ButtonInteraction;

const ctx = { db: fakeDb(sessionRow), log: { error: () => undefined, info: () => undefined, warn: () => undefined } } as unknown as Pick<CoreDeps, "db" | "log">;

const calls: Array<{ interaction: ChatInputCommandInteraction; options: unknown }> = [];
const replaySlashCommand = async (replay: ChatInputCommandInteraction, options: unknown) => {
  calls.push({ interaction: replay, options });
};

const handled = await handleAnonymousSurveyButton(interaction, ctx, replaySlashCommand);
assert.equal(handled, true);
assert.equal(replies.length, 0);
assert.equal(calls.length, 1);
assert.deepEqual(calls[0]?.options, { skipSurvey: true });
assert.equal(calls[0]?.interaction.commandName, "q");
assert.equal(calls[0]?.interaction.guildId, "guild");
assert.equal(calls[0]?.interaction.user.id, "user");

console.log("surveyHandlers.replay.spec.ts: all assertions passed");

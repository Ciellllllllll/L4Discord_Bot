import assert from "node:assert/strict";
import { MessageFlags, PermissionFlagsBits, type ChatInputCommandInteraction, type GuildMember } from "discord.js";
import type { BotContext } from "../bot/context.js";
import { buildAiPingReply, handleSwitch } from "./slashHandlers.js";
import type { AiRoutePreference } from "../features/ai/providerTypes.js";

function member(admin: boolean): GuildMember {
  return {
    id: "user",
    guild: { ownerId: "owner" },
    permissions: { has: (permission: bigint) => admin && permission === PermissionFlagsBits.Administrator },
    roles: { cache: { has: () => false } },
  } as unknown as GuildMember;
}

function interaction(provider: string, replies: unknown[]): ChatInputCommandInteraction {
  return {
    guildId: "guild",
    options: { getString: () => provider },
    reply: async (payload: unknown) => { replies.push(payload); return {} as never; },
  } as unknown as ChatInputCommandInteraction;
}

async function main(): Promise<void> {
  const ping = buildAiPingReply({
    ms: 12,
    provider: "openai",
    model: `unsafe\`\r\n@everyone ${"x".repeat(200)}`,
  }, true, "Go worker: **OK**");
  assert.deepEqual(ping.allowedMentions, { parse: [] });
  assert.equal(/[\r\n`@]/.test(ping.content.match(/Model: \*\*(.*?)\*\*/)?.[1] ?? ""), false);
  assert.ok(ping.content.length <= 2000);

  const replies: unknown[] = [];
  const selected: AiRoutePreference[] = [];
  let current: AiRoutePreference = { provider: "openai", openAiModel: "gpt56" };
  const ctx = {
    config: { OWNER_ID: "owner", ADMIN_ROLE_ID: "admin-role" },
    aiRouter: {
      async getPreference() { return current; },
      async setPreference(_guildId: string, preference: AiRoutePreference) {
        selected.push(preference);
        current = preference;
      },
      async getStatus() {
        return {
          preferredProvider: current.provider,
          preferredOpenAiModel: current.openAiModel,
          effectiveProvider: current.provider,
          ...(current.provider === "openai"
            ? { effectiveModel: current.openAiModel === "gpt56" ? "gpt-5.6-terra" : "gpt-5.4-mini-2026-03-17" }
            : { fallbackReason: "manual_deepseek" }),
          resetAtUtc: "2026-07-11T00:00:00.000Z",
        };
      },
    },
  } as unknown as BotContext;

  await handleSwitch(interaction("openai_gpt56", replies), ctx, member(false));
  assert.deepEqual(selected, []);
  assert.deepEqual(replies[0], { content: "権限がありません。", flags: MessageFlags.Ephemeral });

  replies.length = 0;
  await handleSwitch(interaction("openai_gpt54_mini", replies), ctx, member(true));
  assert.deepEqual(selected, [{ provider: "openai", openAiModel: "gpt54_mini" }]);
  const response = replies[0] as { content: string; flags: MessageFlags };
  assert.equal(response.flags, MessageFlags.Ephemeral);
  assert.match(response.content, /希望: \*\*GPT-5\.4 mini\*\*/);
  assert.match(response.content, /次回実効: \*\*GPT-5\.4 mini\*\*/);
  assert.match(response.content, /2026-07-11T00:00:00\.000Z/);

  replies.length = 0;
  await handleSwitch(interaction("deepseek", replies), ctx, member(true));
  assert.deepEqual(selected.at(-1), { provider: "deepseek", openAiModel: "gpt54_mini" });
  assert.match((replies[0] as { content: string }).content, /希望: \*\*DeepSeek\*\*/);

  replies.length = 0;
  await handleSwitch(interaction("openai_gpt56", replies), ctx, member(true));
  assert.deepEqual(selected.at(-1), { provider: "openai", openAiModel: "gpt56" });
  assert.match((replies[0] as { content: string }).content, /Terra利用不能時.*GPT-5\.4 mini/);

  replies.length = 0;
  await handleSwitch(interaction("invalid", replies), ctx, member(true));
  assert.match((replies[0] as { content: string }).content, /不正/);

  console.log("switchHandler.spec.ts: all assertions passed");
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });

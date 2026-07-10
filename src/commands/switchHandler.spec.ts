import assert from "node:assert/strict";
import { MessageFlags, PermissionFlagsBits, type ChatInputCommandInteraction, type GuildMember } from "discord.js";
import type { BotContext } from "../bot/context.js";
import { handleSwitch } from "./slashHandlers.js";

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
  const replies: unknown[] = [];
  const selected: string[] = [];
  const ctx = {
    config: { OWNER_ID: "owner", ADMIN_ROLE_ID: "admin-role" },
    aiRouter: {
      async setPreferredProvider(_guildId: string, provider: string) { selected.push(provider); },
      async getStatus() {
        return {
          preferredProvider: "openai",
          effectiveProvider: "deepseek",
          fallbackReason: "budget_threshold",
          resetAtUtc: "2026-07-11T00:00:00.000Z",
        };
      },
    },
  } as unknown as BotContext;

  await handleSwitch(interaction("openai", replies), ctx, member(false));
  assert.deepEqual(selected, []);
  assert.deepEqual(replies[0], { content: "権限がありません。", flags: MessageFlags.Ephemeral });

  replies.length = 0;
  await handleSwitch(interaction("openai", replies), ctx, member(true));
  assert.deepEqual(selected, ["openai"]);
  const response = replies[0] as { content: string; flags: MessageFlags };
  assert.equal(response.flags, MessageFlags.Ephemeral);
  assert.match(response.content, /希望: \*\*GPT-5\.6 Terra\*\*/);
  assert.match(response.content, /次回実効: \*\*DeepSeek\*\*/);
  assert.match(response.content, /安全しきい値/);
  assert.match(response.content, /2026-07-11T00:00:00\.000Z/);

  console.log("switchHandler.spec.ts: all assertions passed");
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });

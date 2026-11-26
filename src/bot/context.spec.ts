import assert from "node:assert/strict";
import { test } from "node:test";
import type { ButtonInteraction } from "discord.js";
import type { AppealsRow } from "../core/db/types.js";
import { APPEAL_REVIEW_PREFIX } from "../features/appeals/appealConstants.js";
import type { CancelPendingModmailReplies } from "../features/appeals/appealHandlers.js";
import { handleAppealReviewButton } from "../features/appeals/appealHandlers.js";
import { cancelPendingRepliesByAppeal } from "../features/modmail/modmailStaffFlow.js";
import { botCancelPendingModmailReplies } from "./appealModmailWiring.js";

// appeals は modmail を直接 import せず、BotContext に組み立て時に modmail の実装が
// 入る。index.ts は bot 層の束縛を使い、異議申し立ての審査パスは ctx 経由でそれを呼ぶ。

test("bot layer wires the modmail implementation of cancelPendingModmailReplies", () => {
  assert.equal(botCancelPendingModmailReplies, cancelPendingRepliesByAppeal);
});

type ReviewDeps = Parameters<typeof handleAppealReviewButton>[1];

function createAppealRow(appealId: string): AppealsRow {
  return {
    id: appealId,
    code: "AP-TEST01",
    guild_id: "guild-1",
    user_id: "user-1",
    punishment_type: "ban",
    punishment_reason: "test",
    timeout_start: 0,
    timeout_end: 0,
    status: "pending",
    appeal_reason: "please",
    detecter_incident_id: null,
    created_at: new Date(0),
    updated_at: new Date(0),
    reviewer_id: null,
    review_note: null,
    review_message_id: null,
    hold_thread_id: null,
  };
}

test("appeal review path calls ctx.cancelPendingModmailReplies with the appeal id", async () => {
  const appealId = "appeal-1";
  const row = createAppealRow(appealId);
  const ticketDb = {
    selectFrom: () => ({
      selectAll: () => ({
        where: () => ({
          executeTakeFirst: async () => row,
        }),
      }),
    }),
    updateTable: () => ({
      set: (patch: Partial<AppealsRow>) => ({
        where: () => ({
          execute: async () => {
            Object.assign(row, patch);
          },
        }),
      }),
    }),
  } as unknown as ReviewDeps["ticketDb"];
  const client = {
    users: {
      fetch: async () => ({
        id: "user-1",
        username: "user",
        globalName: "User",
        send: async () => undefined,
      }),
    },
  } as unknown as ReviewDeps["client"];
  const cancellationCalls: Array<{ ctx: unknown; appealId: string }> = [];
  const cancelPendingModmailReplies: CancelPendingModmailReplies = async (receivedCtx, receivedAppealId) => {
    cancellationCalls.push({ ctx: receivedCtx, appealId: receivedAppealId });
  };
  const interaction = {
    customId: `${APPEAL_REVIEW_PREFIX}${appealId}|approve`,
    guildId: "guild-1",
    member: { id: "owner-1" },
    user: { id: "owner-1" },
    guild: { members: { fetch: async () => ({ id: "owner-1" }) } },
    message: { id: "message-1", embeds: [], edit: async () => undefined },
    client,
    deferred: false,
    replied: false,
    deferReply: async () => {
      interaction.deferred = true;
    },
    editReply: async () => undefined,
    reply: async () => undefined,
    followUp: async () => undefined,
  } as unknown as ButtonInteraction;
  const ctx = {
    config: { OWNER_ID: "owner-1", ADMIN_ROLE_ID: "" },
    db: ticketDb,
    log: { warn: () => undefined },
    client,
    ticketDb,
    cancelPendingModmailReplies,
  } as unknown as ReviewDeps;

  const handled = await handleAppealReviewButton(interaction, ctx);

  assert.equal(handled, true);
  assert.deepEqual(cancellationCalls.map((call) => call.appealId), [appealId]);
  assert.equal(cancellationCalls[0]?.ctx, ctx);
  assert.equal(row.status, "approved");
});

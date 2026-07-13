import assert from "node:assert/strict";
import { handleExecutionFlowButton } from "./executionFlow.js";

const state = {
  phase: "precheck_pending" as const, invoker_id: "invoker", target_id: "target", channel_id: "channel",
  precheck_message_id: "precheck", poll1_message_id: null, poll2_message_id: null, admin_message_id: null,
  votes_poll1: {}, votes_poll2: {}, poll1_deadline_ms: 0, poll2_deadline_ms: null,
  resolved_action: null, duration_seconds: null, admin_button_fired: false,
};
const row = { id: "flow", guild_id: "guild", kind: "execution_flow", status: "open", message_id: null, state: JSON.stringify(state), state_revision: 0, updated_at: new Date() };
let updated = 0;
let sent = 0;
const replies: string[] = [];
const db = {
  selectFrom: () => {
    const query = { select: () => query, where: () => query, executeTakeFirst: async () => ({ ...row }) };
    return query;
  },
  updateTable: () => {
    const query = { set: () => query, where: () => query, executeTakeFirst: async () => ({ numUpdatedRows: 0n }) };
    return query;
  },
};
const member = { roles: { cache: { has: (id: string) => id === "admin" } }, guild: { ownerId: "owner" }, permissions: { has: () => false } };
const interaction = {
  customId: "exec_approval:flow:approve", user: { id: "operator" }, guildId: "guild", channelId: "channel",
  guild: { members: { fetch: async () => member } },
  channel: { isTextBased: () => true, send: async () => { sent += 1; return { id: "poll1", delete: async () => undefined }; } },
  reply: async ({ content }: { content: string }) => replies.push(content),
  update: async () => { updated += 1; },
};
const ctx = {
  db,
  client: { channels: { fetch: async () => interaction.channel } },
  config: { ADMIN_ROLE_ID: "admin", OWNER_ID: "owner", EXEC_VOTE_SECONDS: 60, EXEC_ADMIN_WAIT_SECONDS: 60 },
  log: { error: () => undefined, warn: () => undefined, info: () => undefined },
};

await handleExecutionFlowButton(interaction as never, ctx as never);
assert.equal(updated, 0, "precheck phase CASに敗北した承認はUIを更新しない");
assert.equal(sent, 0, "precheck phase CASに敗北した承認はpoll1を開始しない");
assert.ok(replies.some((content) => content.includes("再試行")), "CAS敗北はephemeral再試行を返す");

console.log("executionFlow.precheckCas.spec.ts: all assertions passed");

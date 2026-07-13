import assert from "node:assert/strict";
import { beginPoll1 } from "./executionFlow.js";

const state = {
  phase: "poll1_pending" as const, invoker_id: "invoker", target_id: "target", channel_id: "channel",
  precheck_message_id: "precheck", poll1_message_id: null, poll2_message_id: null, admin_message_id: null,
  votes_poll1: {}, votes_poll2: {}, poll1_deadline_ms: 0, poll2_deadline_ms: null,
  resolved_action: null, duration_seconds: null, admin_button_fired: false,
};

let sent = 0;
const row = { id: "flow", guild_id: "guild", kind: "execution_flow", status: "open", message_id: null, state: JSON.stringify(state), state_revision: 0, updated_at: new Date() };
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
const ctx = {
  db,
  client: { channels: { fetch: async () => ({ isTextBased: () => true, send: async () => { sent += 1; return { id: "poll1" }; } }) } },
  config: { EXEC_VOTE_SECONDS: 60 },
  log: { error: () => undefined, warn: () => undefined },
};

const started = await beginPoll1(ctx as never, "flow", state);
assert.equal(started, false);
assert.equal(sent, 0, "poll1 phase CASに敗北した場合は投票メッセージを送信しない");

console.log("executionFlow.beginPoll1.spec.ts: all assertions passed");

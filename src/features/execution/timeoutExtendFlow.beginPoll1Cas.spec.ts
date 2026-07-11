import assert from "node:assert/strict";
import { beginTePoll1 } from "./timeoutExtendFlow.js";

const state = {
  phase: "poll1_pending" as const, invoker_id: "invoker", target_id: "target", channel_id: "channel",
  poll1_message_id: null, poll2_message_id: null, admin_message_id: null,
  votes_poll1: {}, votes_poll2: {}, poll1_deadline_ms: 0, poll2_deadline_ms: null,
  resolved_extend: null, duration_seconds: null, admin_button_fired: false,
};

function createFixture(updateResults: bigint[]) {
  let sent = 0;
  let deleted = 0;
  const row = { id: "flow", guild_id: "guild", kind: "timeout_extend", status: "open", message_id: null, state: JSON.stringify(state), state_revision: 0, updated_at: new Date() };
  const db = {
    selectFrom: () => {
      const query = { select: () => query, where: () => query, executeTakeFirst: async () => ({ ...row }) };
      return query;
    },
    updateTable: () => {
      let values: Record<string, unknown> = {};
      const query = {
        set: (next: Record<string, unknown>) => { values = next; return query; }, where: () => query,
        executeTakeFirst: async () => {
          const numUpdatedRows = updateResults.shift() ?? 0n;
          if (numUpdatedRows === 1n) Object.assign(row, values);
          return { numUpdatedRows };
        },
      };
      return query;
    },
  };
  const voteChannel = { id: "channel", isTextBased: () => true, isDMBased: () => false, send: async () => ({ id: `message-${++sent}`, delete: async () => { deleted += 1; } }) };
  const ctx = {
    db,
    client: { channels: { fetch: async () => voteChannel } },
    config: { EXEC_VOTE_SECONDS: 60, TIMEOUT_EXTEND_VOTE_CHANNEL_ID: "", TIMEOUT_EXTEND_ADMIN_WAIT_SECONDS: 60, OWNER_ID: "owner", ADMIN_ROLE_ID: "admin" },
    log: { error: () => undefined, warn: () => undefined },
  };
  return { ctx, sent: () => sent, deleted: () => deleted };
}

{
  const fixture = createFixture([0n]);
  const started = await beginTePoll1(fixture.ctx as never, "flow", "guild", state);
  assert.equal(started, false);
  assert.equal(fixture.sent(), 0, "予約CASに敗北した場合は投票メッセージを送信しない");
}

{
  const fixture = createFixture([1n, 0n]);
  const started = await beginTePoll1(fixture.ctx as never, "flow", "guild", state);
  assert.equal(started, false);
  assert.equal(fixture.sent(), 1, "予約CASの勝者だけが送信する");
  assert.equal(fixture.deleted(), 1, "送信後のmessage_id保存CASに敗北したメッセージを削除する");
}

console.log("timeoutExtendFlow.beginPoll1Cas.spec.ts: all assertions passed");

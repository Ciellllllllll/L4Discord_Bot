import assert from "node:assert/strict";
import { startExecutionFlow } from "./executionFlowEntry.js";

function createFixture(updateResults: bigint[]) {
  let row: Record<string, unknown> | undefined;
  let sent = 0;
  let deleted = 0;
  const db = {
    insertInto: () => ({ values: (values: Record<string, unknown>) => ({ execute: async () => { row = { ...values }; } }) }),
    selectFrom: () => {
      const query = { select: () => query, where: () => query, executeTakeFirst: async () => row ? { ...row } : undefined };
      return query;
    },
    updateTable: () => {
      let values: Record<string, unknown> = {};
      const query = {
        set: (next: Record<string, unknown>) => { values = next; return query; }, where: () => query,
        executeTakeFirst: async () => {
          const numUpdatedRows = updateResults.shift() ?? 0n;
          if (numUpdatedRows === 1n && row) Object.assign(row, values);
          return { numUpdatedRows };
        },
      };
      return query;
    },
    deleteFrom: () => ({ where: () => ({ execute: async () => undefined }) }),
  };
  const channel = { id: "channel", isTextBased: () => true, isDMBased: () => false, send: async () => ({ id: `message-${++sent}`, delete: async () => { deleted += 1; } }) };
  const target = { id: "target", roles: { cache: { has: () => false } }, guild: { ownerId: "owner" }, permissions: { has: () => false } };
  const replies: string[] = [];
  const interaction = {
    guild: { id: "guild", members: { fetch: async () => target } }, channel, user: { id: "invoker" },
    options: { getUser: () => ({ id: "target" }) }, deferReply: async () => undefined,
    editReply: async ({ content }: { content: string }) => replies.push(content),
  };
  const ctx = {
    db, client: { channels: { fetch: async () => channel } },
    config: { EXECUTOR_ROLE_ID: "executor", EXEC_VOTE_SECONDS: 60, EXEC_ADMIN_WAIT_SECONDS: 60, OWNER_ID: "owner", ADMIN_ROLE_ID: "admin" },
    log: { error: () => undefined, warn: () => undefined, info: () => undefined },
  };
  return { ctx, interaction, sent: () => sent, deleted: () => deleted };
}

{
  const fixture = createFixture([0n]);
  await startExecutionFlow(fixture.interaction as never, fixture.ctx as never);
  assert.equal(fixture.sent(), 0, "事前承認の予約CASに敗北した場合は投稿しない");
}

{
  const fixture = createFixture([1n, 0n]);
  await startExecutionFlow(fixture.interaction as never, fixture.ctx as never);
  assert.equal(fixture.sent(), 1);
  assert.equal(fixture.deleted(), 1, "事前承認のmessage_id保存CASに敗北した投稿を削除する");
}

console.log("executionFlow.initialPrecheckCas.spec.ts: all assertions passed");

import assert from "node:assert/strict";
import { claimExecutionApproval } from "./executionFlow.js";

const state = {
  phase: "admin_pending" as const,
  invoker_id: "invoker", target_id: "target", channel_id: "channel",
  precheck_message_id: null, poll1_message_id: null, poll2_message_id: null, admin_message_id: "admin",
  votes_poll1: {}, votes_poll2: {}, poll1_deadline_ms: 0, poll2_deadline_ms: null,
  resolved_action: "kick" as const, duration_seconds: null, admin_button_fired: false,
};

let claimed = false;
const db = {
  updateTable: () => ({
    set: () => {
      const query = {
        where: () => query,
        executeTakeFirst: async () => ({ numUpdatedRows: claimed ? 0n : (claimed = true, 1n) }),
      };
      return query;
    },
  }),
};

let externalActions = 0;
let alreadyProcessed = 0;
await Promise.all([0, 1].map(async () => {
  if (await claimExecutionApproval({ db } as never, { id: "flow", status: "open", state } as never, state)) {
    externalActions += 1;
  } else {
    alreadyProcessed += 1;
  }
}));

assert.equal(externalActions, 1);
assert.equal(alreadyProcessed, 1);
console.log("executionFlow.approval.spec.ts: all assertions passed");

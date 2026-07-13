import assert from "node:assert/strict";
import { parseExecutionApprovalCustomId, parseExecutionVoteCustomId } from "./executionFlow.js";
import { parseTimeoutExtendApprovalCustomId, parseTimeoutExtendVoteCustomId } from "./timeoutExtendFlow.js";

{
  assert.deepEqual(parseExecutionVoteCustomId("exec_vote:flow:with:colon:1"), {
    flowId: "flow:with:colon",
    choice: "1",
  });
  assert.equal(parseExecutionVoteCustomId("exec_vote::1"), null);
  assert.deepEqual(parseExecutionApprovalCustomId("exec_approval:flow:with:colon:approve"), {
    flowId: "flow:with:colon",
    action: "approve",
  });
  assert.equal(parseExecutionApprovalCustomId("exec_approval:flow:other"), null);
}

{
  assert.deepEqual(parseTimeoutExtendVoteCustomId("te_vote:flow:with:colon:extend"), {
    flowId: "flow:with:colon",
    choice: "extend",
  });
  assert.equal(parseTimeoutExtendVoteCustomId("te_vote::extend"), null);
  assert.deepEqual(parseTimeoutExtendApprovalCustomId("te_approval:flow:with:colon:deny"), {
    flowId: "flow:with:colon",
    action: "deny",
  });
  assert.equal(parseTimeoutExtendApprovalCustomId("te_approval:flow:other"), null);
}

console.log("flowCustomId.spec.ts: all assertions passed");

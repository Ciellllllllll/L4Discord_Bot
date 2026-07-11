import assert from "node:assert/strict";
import { claimTimeoutExtendApproval, tryClaimTimeoutExtendApproval } from "./timeoutExtendFlow.js";

const state = { phase: "admin_pending" as const, invoker_id: "i", target_id: "t", channel_id: "c", poll1_message_id: null, poll2_message_id: null, admin_message_id: "a", votes_poll1: {}, votes_poll2: {}, poll1_deadline_ms: 0, poll2_deadline_ms: null, resolved_extend: "extend" as const, duration_seconds: 60, admin_button_fired: false };
let claimed = false;
const errors: unknown[] = [];
const db = { updateTable: () => ({ set: () => { const q = { where: () => q, executeTakeFirst: async () => ({ numUpdatedRows: claimed ? 0n : (claimed = true, 1n) }) }; return q; } }) };
let actions = 0;
await Promise.all([0, 1].map(async () => { if (await claimTimeoutExtendApproval({ db, log: { error: (entry: unknown) => errors.push(entry) } } as never, { id: "flow", guild_id: "guild", status: "open", state } as never, state)) actions += 1; }));
assert.equal(actions, 1);

const failingDb = { updateTable: () => ({ set: () => { const q = { where: () => q, executeTakeFirst: async () => { throw new Error("db"); } }; return q; } }) };
await assert.rejects(() => claimTimeoutExtendApproval({ db: failingDb, log: { error: (entry: unknown) => errors.push(entry) } } as never, { id: "flow2", guild_id: "guild", status: "open", state } as never, state), /db/);
assert.ok(errors.some((entry) => (entry as { flowId?: string }).flowId === "flow2"));
const failure = await tryClaimTimeoutExtendApproval({ db: failingDb, log: { error: (entry: unknown) => errors.push(entry) } } as never, { id: "flow3", guild_id: "guild", status: "open", state } as never, state);
assert.equal(failure.ok, false);
if (!failure.ok) assert.match(String(failure.error), /db/);
console.log("timeoutExtendFlow.approval.spec.ts: all assertions passed");

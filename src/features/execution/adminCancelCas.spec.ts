import assert from "node:assert/strict";
import { abortFlow } from "./executionFlow.js";
import { abortTeFlow } from "./timeoutExtendFlow.js";

function executionState(adminButtonFired: boolean) {
  return {
    phase: "admin_pending" as const, invoker_id: "invoker", target_id: "target", channel_id: "channel",
    precheck_message_id: null, poll1_message_id: null, poll2_message_id: null, admin_message_id: "admin",
    votes_poll1: {}, votes_poll2: {}, poll1_deadline_ms: 0, poll2_deadline_ms: null,
    resolved_action: "kick" as const, duration_seconds: null, admin_button_fired: adminButtonFired,
  };
}

function timeoutState(adminButtonFired: boolean) {
  return {
    phase: "admin_pending" as const, invoker_id: "invoker", target_id: "target", channel_id: "channel",
    poll1_message_id: null, poll2_message_id: null, admin_message_id: "admin",
    votes_poll1: {}, votes_poll2: {}, poll1_deadline_ms: 0, poll2_deadline_ms: null,
    resolved_extend: "extend" as const, duration_seconds: 60, admin_button_fired: adminButtonFired,
  };
}

async function assertClaimedFlowIsNotCancelled(
  abort: (ctx: never, id: string, state: never, heading: string, guildId: string, row: never) => Promise<boolean>,
  kind: string,
  beforeClaim: Record<string, unknown>,
  claimed: Record<string, unknown>,
): Promise<void> {
  const row: Record<string, unknown> = {
    id: `${kind}-flow`, guild_id: "guild", kind, status: "open", message_id: null,
    state: JSON.stringify(claimed), state_revision: 1, updated_at: new Date(),
  };
  const staleRow = { ...row, state: JSON.stringify(beforeClaim), state_revision: 0 };
  let fetched = 0;
  const ctx = {
    db: {
      updateTable: () => {
        let values: Record<string, unknown> = {};
        const predicates: Array<[string, unknown]> = [];
        const query = {
          set(next: Record<string, unknown>) { values = next; return query; },
          where(column: string, _operator: string, value: unknown) { predicates.push([column, value]); return query; },
          async executeTakeFirst() {
            const matched = predicates.every(([column, value]) => row[column] === value);
            if (!matched) return { numUpdatedRows: 0n };
            Object.assign(row, values);
            return { numUpdatedRows: 1n };
          },
        };
        return query;
      },
    },
    client: { channels: { fetch: async () => { fetched += 1; return null; } } },
    log: { error: () => undefined, warn: () => undefined },
  };
  const cancelled = await abort(ctx as never, String(row.id), beforeClaim as never, "timeout", "guild", staleRow as never);
  assert.equal(cancelled, false, `${kind}: claim に敗北した timeout/cancel は終端化しない`);
  assert.equal(row.status, "open");
  assert.equal(row.state, JSON.stringify(claimed));
  assert.equal(fetched, 0, `${kind}: CAS敗北時はUIを更新しない`);
}

await assertClaimedFlowIsNotCancelled(abortFlow, "execution_flow", executionState(false), executionState(true));
await assertClaimedFlowIsNotCancelled(abortTeFlow, "timeout_extend", timeoutState(false), timeoutState(true));

console.log("adminCancelCas.spec.ts: all assertions passed");

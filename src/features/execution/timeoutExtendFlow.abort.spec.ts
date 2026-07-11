import assert from "node:assert/strict";
import { abortTeFlow } from "./timeoutExtendFlow.js";

const state = {
  phase: "poll1_pending" as const,
  invoker_id: "invoker", target_id: "target", channel_id: "channel",
  poll1_message_id: "poll", poll2_message_id: null, admin_message_id: null,
  votes_poll1: {}, votes_poll2: {}, poll1_deadline_ms: 0, poll2_deadline_ms: null,
  resolved_extend: null, duration_seconds: null, admin_button_fired: false,
};

const row = {
  id: "timeout-flow", guild_id: "guild", kind: "timeout_extend", status: "open", message_id: null,
  state: JSON.stringify(state), state_revision: 0, updated_at: new Date(),
};
const editPayloads: Array<{ components?: unknown[] }> = [];
const ctx = {
  db: {
    selectFrom: () => {
      const query = { select: () => query, where: () => query, executeTakeFirst: async () => ({ ...row }) };
      return query;
    },
    updateTable: () => {
      let values: Record<string, unknown> = {};
      const predicates: Array<[string, unknown]> = [];
      const query = {
        set: (next: Record<string, unknown>) => { values = next; return query; },
        where: (column: string, _operator: string, value: unknown) => { predicates.push([column, value]); return query; },
        executeTakeFirst: async () => {
          assert.ok(predicates.some(([column]) => column === "state_revision"), "terminal CAS はrevisionを比較する");
          Object.assign(row, values);
          return { numUpdatedRows: 1n };
        },
      };
      return query;
    },
  },
  client: { channels: { fetch: async () => ({ isTextBased: () => true, messages: { fetch: async () => ({ edit: async (payload: { components?: unknown[] }) => { editPayloads.push(payload); } }) } }) } },
  log: { error: () => undefined, warn: () => undefined },
};

assert.equal(await abortTeFlow(ctx as never, row.id, state, "stopped", row.guild_id), true);
assert.equal(editPayloads[0]?.components?.length, 1, "中止後も既存投票ボタン行を残す");
const button = (editPayloads[0]?.components?.[0] as { toJSON(): { components: Array<{ custom_id: string; disabled: boolean }> } }).toJSON().components[0]!;
assert.equal(button.custom_id, "te_vote:timeout-flow:extend");
assert.equal(button.disabled, true);

console.log("timeoutExtendFlow.abort.spec.ts: all assertions passed");

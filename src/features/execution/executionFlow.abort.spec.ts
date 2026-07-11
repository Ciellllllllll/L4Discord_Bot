import assert from "node:assert/strict";
import { abortFlow } from "./executionFlow.js";

const state = {
  phase: "poll1_pending" as const,
  invoker_id: "invoker", target_id: "target", channel_id: "channel",
  precheck_message_id: null, poll1_message_id: "poll", poll2_message_id: null, admin_message_id: null,
  votes_poll1: {}, votes_poll2: {}, poll1_deadline_ms: 0, poll2_deadline_ms: null,
  resolved_action: null, duration_seconds: null, admin_button_fired: false,
};

for (const fail of [true, false]) {
  let fetched = 0;
  let edited = 0;
  const editPayloads: Array<{ components?: unknown[] }> = [];
  const row = {
    id: `flow-${fail}`,
    guild_id: "guild",
    kind: "execution_flow",
    status: "open",
    message_id: null,
    state: JSON.stringify(state),
    state_revision: 0,
    updated_at: new Date(),
  };
  const ctx = {
    db: {
      selectFrom: () => {
        const query = {
          select: () => query,
          where: () => query,
          executeTakeFirst: async () => ({ ...row }),
        };
        return query;
      },
      updateTable: () => {
        let values: Record<string, unknown> = {};
        const predicates: Array<[string, unknown]> = [];
        const query = {
          set: (next: Record<string, unknown>) => { values = next; return query; },
          where: (column: string, _operator: string, value: unknown) => { predicates.push([column, value]); return query; },
          executeTakeFirst: async () => {
            if (fail) throw new Error("db");
            const matches = predicates.every(([column, value]) => row[column as keyof typeof row] === value);
            if (!matches) return { numUpdatedRows: 0n };
            Object.assign(row, values);
            return { numUpdatedRows: 1n };
          },
        };
        return query;
      },
    },
    client: { channels: { fetch: async () => { fetched += 1; return { isTextBased: () => true, messages: { fetch: async () => ({ edit: async (payload: { components?: unknown[] }) => { edited += 1; editPayloads.push(payload); } }) } }; } } },
    log: { error: () => undefined, warn: () => undefined },
  };
  const committed = await abortFlow(ctx as never, `flow-${fail}`, state, "stopped", "guild");
  assert.equal(committed, !fail);
  assert.equal(fetched, fail ? 0 : 1);
  assert.equal(edited, fail ? 0 : 1);
  if (!fail) {
    assert.equal(editPayloads[0]?.components?.length, 1, "中止後も既存投票ボタン行を残す");
    const button = (editPayloads[0]?.components?.[0] as { toJSON(): { components: Array<{ custom_id: string; disabled: boolean }> } }).toJSON().components[0]!;
    assert.equal(button.custom_id, "exec_vote:flow-false:1");
    assert.equal(button.disabled, true);
  }
}

console.log("executionFlow.abort.spec.ts: all assertions passed");

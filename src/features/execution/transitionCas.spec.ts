import assert from "node:assert/strict";
import {
  transitionPoll1ToNext,
  transitionPoll2ToAdmin,
} from "./executionFlow.js";
import {
  transitionTePoll1ToNext,
  transitionTePoll2ToAdmin,
} from "./timeoutExtendFlow.js";

type PollRow = {
  id: string;
  guild_id: string;
  kind: string;
  status: string;
  message_id: string | null;
  state: Record<string, unknown>;
  state_revision: number;
  updated_at: Date;
};

function executionPoll1State(): Record<string, unknown> {
  return {
    phase: "poll1_pending", invoker_id: "invoker", target_id: "target", channel_id: "channel",
    precheck_message_id: null, poll1_message_id: "poll1", poll2_message_id: null,
    votes_poll1: { voter: "1" }, votes_poll2: {}, poll1_deadline_ms: Date.now() - 1,
    poll2_deadline_ms: null, admin_message_id: null, resolved_action: null,
    duration_seconds: null, admin_button_fired: false,
  };
}

function timeoutPoll1State(): Record<string, unknown> {
  return {
    phase: "poll1_pending", invoker_id: "invoker", target_id: "target", channel_id: "channel",
    poll1_message_id: "poll1", poll2_message_id: null, admin_message_id: null,
    votes_poll1: { voter: "release" }, votes_poll2: {}, poll1_deadline_ms: Date.now() - 1,
    poll2_deadline_ms: null, resolved_extend: null, duration_seconds: null, admin_button_fired: false,
  };
}

function executionPoll2State(): Record<string, unknown> {
  return { ...executionPoll1State(), phase: "poll2_pending", poll2_message_id: "poll2", votes_poll2: { voter: "1" }, poll2_deadline_ms: Date.now() - 1, resolved_action: "timeout" };
}

function timeoutPoll2State(): Record<string, unknown> {
  return { ...timeoutPoll1State(), phase: "poll2_pending", poll2_message_id: "poll2", votes_poll2: { voter: "s3600" }, poll2_deadline_ms: Date.now() - 1, resolved_extend: "extend" };
}

function createContext(row: PollRow) {
  let sent = 0;
  let disabled = 0;
  const db = {
    selectFrom() {
      const query = {
        select: () => query,
        where: () => query,
        executeTakeFirst: async () => ({ ...row, state: structuredClone(row.state) }),
      };
      return query;
    },
    updateTable() {
      let values: Record<string, unknown> = {};
      const predicates: Array<[string, unknown]> = [];
      const query = {
        set(next: Record<string, unknown>) { values = next; return query; },
        where(column: string, _operator: string, value: unknown) { predicates.push([column, value]); return query; },
        async executeTakeFirst() {
          const matches = predicates.every(([column, value]) => {
            const current = row[column as keyof PollRow];
            return column === "state" ? JSON.stringify(current) === JSON.stringify(value) : current === value;
          });
          if (!matches) return { numUpdatedRows: 0n };
          for (const [key, value] of Object.entries(values)) {
            if (key === "state" && typeof value === "string") row.state = JSON.parse(value);
            else (row as Record<string, unknown>)[key] = value;
          }
          return { numUpdatedRows: 1n };
        },
      };
      return query;
    },
  };
  const oldMessage = { edit: async () => { disabled += 1; } };
  const channel = {
    isTextBased: () => true,
    messages: { fetch: async () => oldMessage },
    send: async () => ({ id: `sent-${++sent}`, delete: async () => undefined }),
  };
  const ctx = {
    db,
    client: { channels: { fetch: async () => channel } },
    config: { EXEC_VOTE_SECONDS: 0, EXEC_ADMIN_WAIT_SECONDS: 0, TIMEOUT_EXTEND_ADMIN_WAIT_SECONDS: 0, ADMIN_ROLE_ID: "admin" },
    log: { error: () => undefined, warn: () => undefined, info: () => undefined },
  };
  return { ctx, sent: () => sent, disabled: () => disabled };
}

{
  const row: PollRow = { id: "execution", guild_id: "guild", kind: "execution", status: "open", message_id: "poll1", state: executionPoll1State(), state_revision: 0, updated_at: new Date() };
  const { ctx, sent, disabled } = createContext(row);
  await Promise.all([transitionPoll1ToNext(ctx as never, row.id), transitionPoll1ToNext(ctx as never, row.id)]);
  assert.equal(sent(), 1, "execution poll2 message is published by only the CAS winner");
  assert.equal(disabled(), 1, "execution old poll UI is disabled by only the CAS winner");
  assert.equal(row.state.phase, "poll2_pending");
  assert.equal(row.state.poll2_message_id, "sent-1");
}

{
  const row: PollRow = { id: "execution-poll2", guild_id: "guild", kind: "execution", status: "open", message_id: "poll2", state: executionPoll2State(), state_revision: 0, updated_at: new Date() };
  const { ctx, sent, disabled } = createContext(row);
  await Promise.all([transitionPoll2ToAdmin(ctx as never, row.id), transitionPoll2ToAdmin(ctx as never, row.id)]);
  assert.equal(sent(), 1, "execution admin request is published by only the CAS winner");
  assert.equal(disabled(), 1, "execution old duration poll UI is disabled by only the CAS winner");
  assert.equal(row.state.phase, "admin_pending");
  assert.equal(row.state.admin_message_id, "sent-1");
}

{
  const row: PollRow = { id: "timeout", guild_id: "guild", kind: "timeout_extend", status: "open", message_id: "poll1", state: timeoutPoll1State(), state_revision: 0, updated_at: new Date() };
  const { ctx, sent, disabled } = createContext(row);
  await Promise.all([transitionTePoll1ToNext(ctx as never, row.id, row.guild_id), transitionTePoll1ToNext(ctx as never, row.id, row.guild_id)]);
  assert.equal(sent(), 1, "timeout admin request is published by only the CAS winner");
  assert.equal(disabled(), 1, "timeout old poll UI is disabled by only the CAS winner");
  assert.equal(row.state.phase, "admin_pending");
  assert.equal(row.state.admin_message_id, "sent-1");
}

{
  const row: PollRow = { id: "timeout-poll2", guild_id: "guild", kind: "timeout_extend", status: "open", message_id: "poll2", state: timeoutPoll2State(), state_revision: 0, updated_at: new Date() };
  const { ctx, sent, disabled } = createContext(row);
  await Promise.all([transitionTePoll2ToAdmin(ctx as never, row.id, row.guild_id), transitionTePoll2ToAdmin(ctx as never, row.id, row.guild_id)]);
  assert.equal(sent(), 1, "timeout duration admin request is published by only the CAS winner");
  assert.equal(disabled(), 1, "timeout old duration poll UI is disabled by only the CAS winner");
  assert.equal(row.state.phase, "admin_pending");
  assert.equal(row.state.admin_message_id, "sent-1");
}

console.log("transitionCas.spec.ts: all assertions passed");

import assert from "node:assert/strict";
import { startExecutionFlow } from "./executionFlow.js";
import { startTimeoutExtendFlow } from "./timeoutExtendFlow.js";

function createDb() {
  const updates: Record<string, unknown>[] = [];
  let row: Record<string, unknown> | undefined;
  return {
    updates,
    insertInto() {
      return {
        values(values: Record<string, unknown>) {
          return {
            execute: async () => {
              row = { ...values };
            },
          };
        },
      };
    },
    selectFrom() {
      const query = {
        select: () => query,
        where: () => query,
        executeTakeFirst: async () => row ? { ...row } : undefined,
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
          const matches = row !== undefined && predicates.every(([column, value]) => row?.[column] === value);
          if (!matches) return { numUpdatedRows: 0n };
          row = { ...row, ...values };
          updates.push(values);
          return { numUpdatedRows: 1n };
        },
      };
      return {
        ...query,
      };
    },
    deleteFrom() {
      return { where: () => ({ execute: async () => undefined }) };
    },
  };
}

function createInteraction() {
  const replies: string[] = [];
  const textChannel = { id: "channel", isTextBased: () => true, isDMBased: () => false };
  const targetMember = {
    id: "target",
    roles: { cache: { has: () => false } },
    guild: { ownerId: "other" },
    permissions: { has: () => false },
    communicationDisabledUntil: new Date(Date.now() + 60_000),
  };
  const guild = { id: "guild", members: { fetch: async () => targetMember } };
  const interaction = {
    guild,
    channel: textChannel,
    channelId: "channel",
    user: { id: "invoker" },
    options: { getUser: () => ({ id: "target" }) },
    deferReply: async () => undefined,
    editReply: async ({ content }: { content: string }) => replies.push(content),
  };
  return { interaction, replies };
}

function createContext(db: ReturnType<typeof createDb>, fetchedChannel: unknown = null) {
  return {
    db,
    client: { channels: { fetch: async () => fetchedChannel } },
    config: {
      EXEC_CHANNEL_ID: "",
      EXECUTOR_ROLE_ID: "",
      EXEC_VOTE_SECONDS: 60,
      EXEC_ADMIN_WAIT_SECONDS: 60,
      TIMEOUT_EXTEND_ADMIN_WAIT_SECONDS: 60,
      TIMEOUT_EXTEND_VOTE_CHANNEL_ID: "",
      OWNER_ID: "owner",
      ADMIN_ROLE_ID: "admin",
    },
    log: { error: () => undefined, warn: () => undefined, info: () => undefined },
  };
}

{
  const db = createDb();
  const { interaction, replies } = createInteraction();
  await startExecutionFlow(interaction as never, createContext(db) as never);
  assert.match(replies.at(-1) ?? "", /開始できませんでした/);
  assert.equal(replies.some((reply) => reply === "処刑投票を開始しました。"), false);
  assert.equal(db.updates.some((update) => update.status === "cancelled"), true);
}

{
  const db = createDb();
  const { interaction, replies } = createInteraction();
  await startTimeoutExtendFlow(interaction as never, createContext(db) as never);
  assert.match(replies.at(-1) ?? "", /開始できませんでした/);
  assert.equal(replies.some((reply) => reply.includes("投票を開始しました")), false);
  assert.equal(db.updates.some((update) => update.status === "cancelled"), true);
}

{
  const db = createDb();
  const { interaction, replies } = createInteraction();
  const channel = {
    id: "channel",
    isTextBased: () => true,
    isDMBased: () => false,
    send: async () => { throw new Error("discord send failed"); },
  };
  await startTimeoutExtendFlow(interaction as never, createContext(db, channel) as never);
  assert.match(replies.at(-1) ?? "", /開始できませんでした/);
  assert.equal(db.updates.some((update) => update.status === "cancelled"), true, "送信例外後もopenフローを残さない");
}

console.log("flowStartFailure.spec.ts: all assertions passed");

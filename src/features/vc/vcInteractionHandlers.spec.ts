import assert from "node:assert/strict";
import { test } from "node:test";
import { handleVcCreateModal, handleVcRenameModal } from "./vcInteractionHandlers.js";
import { buildVcRenameModalCustomId, VC_NAME_MODAL_PREFIX } from "./vcCreatorUi.js";

function createModalInteraction(customId: string, fieldValue: string, calls: string[], options: { editReplyFails?: boolean } = {}) {
  return {
    customId,
    user: { id: "user-1", tag: "user#0001" },
    guild: {
      id: "guild-1",
      members: { cache: new Map([["user-1", { voice: { channel: { id: "111", name: "[ゲーム]:旧名" } } }]]) },
      channels: {
        fetch: async () => {
          calls.push("fetchCreated");
          return null;
        },
      },
    },
    fields: { getTextInputValue: () => fieldValue },
    deferReply: async () => { calls.push("defer"); },
    editReply: async ({ content }: { content: string }) => {
      calls.push(`edit:${content}`);
      if (options.editReplyFails) throw Object.assign(new Error("Unknown interaction"), { code: 10062 });
    },
    reply: async () => { calls.push("reply"); },
  };
}

function createContext(calls: string[]) {
  return {
    log: { warn: (_obj: unknown, msg: string) => { calls.push(`warn:${msg}`); } },
    client: { user: { id: "bot-1" } },
    vcTemp: {
      createTemporaryVc: async () => {
        calls.push("create");
        return { ok: true as const, channelId: "vc-new", name: "[ゲーム]:新VC" };
      },
      isTrackedTemporaryVc: () => true,
      renameTemporaryVc: async () => {
        calls.push("rename");
        return { ok: true as const, channelId: "111", name: "[ゲーム]:新名" };
      },
    },
  };
}

void test("VC create modal defers before creating the channel and edits the deferred reply", async () => {
  const calls: string[] = [];
  const handled = await handleVcCreateModal(
    createModalInteraction(`${VC_NAME_MODAL_PREFIX}ゲーム`, "新VC", calls) as never,
    createContext(calls) as never,
  );
  assert.equal(handled, true);
  assert.deepEqual(calls, ["defer", "create", "edit:VC [ゲーム]:新VC を作成しました", "fetchCreated"]);
});

void test("VC create modal keeps post-create setup running when the completion reply fails", async () => {
  const calls: string[] = [];
  await handleVcCreateModal(
    createModalInteraction(`${VC_NAME_MODAL_PREFIX}ゲーム`, "新VC", calls, { editReplyFails: true }) as never,
    createContext(calls) as never,
  );
  assert.deepEqual(calls, [
    "defer",
    "create",
    "edit:VC [ゲーム]:新VC を作成しました",
    "warn:temporary VC create reply failed",
    "fetchCreated",
  ]);
});

void test("VC rename modal defers before renaming and edits the deferred reply", async () => {
  const calls: string[] = [];
  const handled = await handleVcRenameModal(
    createModalInteraction(buildVcRenameModalCustomId("111", "ゲーム"), "新名", calls) as never,
    createContext(calls) as never,
  );
  assert.equal(handled, true);
  assert.deepEqual(calls, ["defer", "rename", "edit:VC名を [ゲーム]:新名 に変更しました。"]);
});

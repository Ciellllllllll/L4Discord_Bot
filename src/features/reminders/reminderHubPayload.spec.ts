import assert from "node:assert/strict";
import { ComponentType } from "discord.js";
import {
  buildCreateChannelPayload,
  buildCreateModal,
  buildEditModal,
} from "./reminderHubPayload.js";

function modalField(modal: ReturnType<typeof buildCreateModal>, customId: string): { value?: string; required?: boolean } | undefined {
  const json = modal.toJSON() as { components: Array<{ components: Array<{ custom_id?: string; value?: string; required?: boolean }> }> };
  return json.components
    .flatMap((row) => row.components)
    .find((component) => component.custom_id === customId);
}

function run(): void {
  const createPayload = buildCreateChannelPayload("notice");
  const container = createPayload.components[0];
  assert.equal(container?.type, ComponentType.Container);
  const manualEntryButton = container.components
    .filter((component) => component.type === ComponentType.ActionRow)
    .flatMap((row) => (row as { components: Array<{ custom_id?: string }> }).components)
    .find((component) => component.custom_id === "rem_create_channel_id:notice");
  assert.ok(manualEntryButton, "作成画面にチャンネルID手入力ボタンが必要");

  const selectedChannelField = modalField(buildCreateModal("notice", "123456789012345678"), "channel_id");
  assert.equal(selectedChannelField?.required, true);
  assert.equal(selectedChannelField?.value, "123456789012345678");

  const editModal = buildEditModal({
    id: "item-1",
    ev_type: "notice",
    title: "お知らせ",
    body: "本文",
    channel_id: "234567890123456789",
    author_id: "user-1",
    fire_at: "2026-07-25T00:00:00.000Z",
    status: "active",
    recurrence_json: null,
  });
  assert.ok(editModal, "通常IDの編集モーダルが生成されること");
  const editCustomId = (editModal.toJSON() as { custom_id?: string }).custom_id ?? "";
  assert.equal(
    editCustomId,
    `rem_manage_edit_modal:item-1:${Date.parse("2026-07-25T00:00:00.000Z")}`,
  );
  assert.ok(editCustomId.length <= 100);
  const editChannelField = modalField(editModal, "channel_id");
  assert.equal(editChannelField?.required, true);
  assert.equal(editChannelField?.value, "234567890123456789");

  const oversizedEditModal = buildEditModal({
    id: "x".repeat(80),
    ev_type: "notice",
    title: "お知らせ",
    body: "本文",
    channel_id: "234567890123456789",
    author_id: "user-1",
    fire_at: "2026-07-25T00:00:00.000Z",
    status: "active",
    recurrence_json: null,
  });
  assert.equal(oversizedEditModal, null, "100文字を超える場合は旧形式へフォールバックせず null を返すこと");

  const invalidFireAtModal = buildEditModal({
    id: "item-2",
    ev_type: "notice",
    title: "お知らせ",
    body: "本文",
    channel_id: "234567890123456789",
    author_id: "user-1",
    fire_at: "invalid-date",
    status: "active",
    recurrence_json: null,
  });
  assert.ok(invalidFireAtModal, "fire_at がパースできない場合も番兵値 0 で編集モーダルを生成すること");
  assert.equal(
    (invalidFireAtModal.toJSON() as { custom_id?: string }).custom_id,
    "rem_manage_edit_modal:item-2:0",
  );
  const invalidDueField = modalField(invalidFireAtModal, "due_at");
  assert.equal(invalidDueField?.value, "");
}

run();
console.log("reminderHubPayload.spec.ts: all assertions passed");

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

  const editChannelField = modalField(
    buildEditModal({
      id: "item-1",
      ev_type: "notice",
      title: "お知らせ",
      body: "本文",
      channel_id: "234567890123456789",
      author_id: "user-1",
      fire_at: "2026-07-25T00:00:00.000Z",
      status: "active",
      recurrence_json: null,
    }),
    "channel_id",
  );
  assert.equal(editChannelField?.required, true);
  assert.equal(editChannelField?.value, "234567890123456789");
}

run();
console.log("reminderHubPayload.spec.ts: all assertions passed");

import assert from "node:assert/strict";
import { ComponentType } from "discord.js";
import { buildModmailStartDmPayload } from "./modmailService.js";
import { MM_IDS } from "./modmailIds.js";
import { buildModmailTicketCreateRow } from "./modmailUi.js";

function run(): void {
  const active = buildModmailStartDmPayload([buildModmailTicketCreateRow("ctx")]);
  assert.equal(active.embeds.length, 0);
  assert.equal(active.components[0]?.type, ComponentType.Container);
  assert.equal(active.components.length, 1);
  const activeRow = active.components[0]?.components.at(-1);
  assert.equal(activeRow?.type, ComponentType.ActionRow);
  if (activeRow?.type === ComponentType.ActionRow) {
    assert.equal(activeRow.components[0]?.type, ComponentType.Button);
    const button = activeRow.components[0];
    assert.ok(button && "custom_id" in button);
    if (button && "custom_id" in button) {
      assert.equal(button.custom_id, `${MM_IDS.TICKET_START_PREFIX}ctx`);
    }
  }

  const disabled = buildModmailStartDmPayload([]);
  assert.equal(disabled.embeds.length, 0);
  assert.equal(disabled.components[0]?.type, ComponentType.Container);
  assert.equal(disabled.components.length, 1);
  assert.equal(disabled.components[0]?.components.some((component) => component.type === ComponentType.ActionRow), false);
}

run();
console.log("modmailStartDmPayload.spec.ts: all assertions passed");

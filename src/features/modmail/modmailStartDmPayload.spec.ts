import assert from "node:assert/strict";
import { ComponentType } from "discord.js";
import { buildModmailStartDmPayload } from "./modmailService.js";
import { buildModmailTicketCreateRow } from "./modmailUi.js";

function run(): void {
  const active = buildModmailStartDmPayload([buildModmailTicketCreateRow("ctx")]);
  assert.equal(active.embeds.length, 0);
  assert.equal(active.components[0]?.type, ComponentType.Container);
  assert.equal(active.components.length, 2);

  const disabled = buildModmailStartDmPayload([]);
  assert.equal(disabled.embeds.length, 0);
  assert.equal(disabled.components[0]?.type, ComponentType.Container);
  assert.equal(disabled.components.length, 1);
}

run();
console.log("modmailStartDmPayload.spec.ts: all assertions passed");

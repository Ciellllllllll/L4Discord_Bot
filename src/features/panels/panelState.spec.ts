import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePanelState } from "./panelState.js";

test("parsePanelState falls back to the pending default for malformed or non-object JSON", () => {
  const expected = { ui_version: "0.0.0", status: "pending", last_error: undefined, last_sent_at: undefined };
  assert.deepEqual(parsePanelState("{"), expected);
  assert.deepEqual(parsePanelState("[]"), expected);
  assert.deepEqual(parsePanelState(null), expected);
  assert.deepEqual(parsePanelState('{"ui_version":"2.0.0","status":"sent"}'), {
    ui_version: "2.0.0",
    status: "sent",
    last_error: undefined,
    last_sent_at: undefined,
  });
});

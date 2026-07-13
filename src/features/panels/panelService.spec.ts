import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcileReactionRoleEntriesOnly } from "../reactionRoles/reactionRoleService.js";
import { reconcilePanelsForGuild } from "./panelService.js";

test("panel reconciliation rejects when the target guild cannot be fetched", async () => {
  const ctx = {
    client: { guilds: { fetch: async () => null } },
  };

  await assert.rejects(
    () => reconcilePanelsForGuild(ctx as never, "guild-1"),
    /target guild unavailable for panel reconciliation: guild-1/,
  );
});

test("reaction-role entry reconciliation returns each failed entry for startup aggregation", async () => {
  const warnings: Array<Record<string, unknown>> = [];
  const ctx = {
    db: {
      selectFrom: () => ({
        select: () => ({
          where: () => ({
            execute: async () => [{
              entry_id: "entry-1",
              channel_id: "channel-1",
              message_id: "",
              title: "Title",
              description: "Description",
              roles_json: JSON.stringify([{ roleId: "123456789012345678", label: "Role" }]),
            }],
          }),
        }),
      }),
    },
    client: { user: { id: "bot-1" } },
    log: { warn: (bindings: Record<string, unknown>) => warnings.push(bindings) },
  };
  const guild = {
    id: "guild-1",
    channels: { cache: new Map(), fetch: async () => null },
  };

  const failures = await reconcileReactionRoleEntriesOnly(ctx as never, guild as never);

  assert.deepEqual(failures, ["reaction_role_entry:entry-1"]);
  assert.deepEqual(warnings[0], {
    entryId: "entry-1",
    guildId: "guild-1",
    panelKind: "reaction_role_admin",
    err: warnings[0]?.err,
  });
});

console.log("panelService.spec.ts: all assertions passed");

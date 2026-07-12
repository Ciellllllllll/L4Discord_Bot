import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelType, type Guild } from "discord.js";
import { VcTemporaryChannelManager } from "./vcTemporaryChannelManager.js";
import type { VcTempPersistence } from "./vcTempPersistence.js";

function createFixture(options: { deleteFails?: boolean; trackingDeleteFails?: boolean } = {}) {
  let deleted = false;
  let trackingDeleteCalls = 0;
  const errors: unknown[][] = [];
  const created = {
    id: "temporary-vc",
    type: ChannelType.GuildVoice,
    delete: async () => {
      deleted = true;
      if (options.deleteFails) throw new Error("delete failed");
    },
  };
  const guild = {
    id: "guild",
    channels: {
      cache: new Map([["base-vc", { id: "base-vc", type: ChannelType.GuildVoice, rawPosition: 1, parentId: null }]]),
      create: async () => created,
    },
  } as unknown as Guild;
  const persistence = {
    insertTracked: async () => { throw new Error("database unavailable"); },
    deleteTracked: async () => {
      trackingDeleteCalls += 1;
      if (options.trackingDeleteFails) throw new Error("tracking delete failed");
    },
  } as unknown as VcTempPersistence;
  const manager = new VcTemporaryChannelManager(
    { warn: () => undefined, error: (...args: unknown[]) => { errors.push(args); } } as never,
    {} as never,
    {} as never,
    persistence,
  );
  return { manager, guild, errors, wasDeleted: () => deleted, trackingDeleteCalls: () => trackingDeleteCalls };
}

test("createTemporaryVc compensates a tracking persistence failure", async () => {
  const fixture = createFixture();
  const result = await fixture.manager.createTemporaryVc(fixture.guild, { name: "テストVC", creatorUserId: "user", creatorTag: "user" });
  assert.deepEqual(result, { ok: false, error: "api_error" });
  assert.equal(fixture.wasDeleted(), true);
  assert.equal(fixture.trackingDeleteCalls(), 1);
  assert.equal(fixture.manager.isTrackedTemporaryVc("temporary-vc"), false);
});

test("createTemporaryVc logs compensation tracking deletion failures without retaining tracking", async () => {
  const fixture = createFixture({ trackingDeleteFails: true });
  const result = await fixture.manager.createTemporaryVc(fixture.guild, { name: "テストVC", creatorUserId: "user", creatorTag: "user" });
  assert.deepEqual(result, { ok: false, error: "api_error" });
  assert.equal(fixture.trackingDeleteCalls(), 1);
  assert.equal(fixture.manager.isTrackedTemporaryVc("temporary-vc"), false);
  assert.equal(fixture.errors.length, 1);
});

test("createTemporaryVc logs Discord compensation deletion failures without retaining tracking", async () => {
  const fixture = createFixture({ deleteFails: true });
  await fixture.manager.createTemporaryVc(fixture.guild, { name: "テストVC", creatorUserId: "user", creatorTag: "user" });
  assert.equal(fixture.manager.isTrackedTemporaryVc("temporary-vc"), false);
  assert.equal(fixture.errors.length, 1);
});

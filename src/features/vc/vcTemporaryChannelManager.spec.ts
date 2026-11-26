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

test("restoreFromDatabase and renameTemporaryVc retain tracking on transient fetch errors and remove on Unknown Channel", async () => {
  const deletedIds: string[] = [];
  const warns: unknown[][] = [];
  let fetchBehavior: () => Promise<unknown> = async () => {
    throw Object.assign(new Error("Service Unavailable"), { status: 503 });
  };

  const client = {
    channels: {
      cache: new Map(),
      fetch: async () => fetchBehavior(),
    },
  };
  const persistence = {
    listTracked: async () => [{ channelId: "vc-1", guildId: "guild-1", createdAtMs: Date.now(), userEverJoined: false }],
    deleteTracked: async (id: string) => {
      deletedIds.push(id);
    },
  } as unknown as VcTempPersistence;

  const manager = new VcTemporaryChannelManager(
    {
      warn: (...args: unknown[]) => { warns.push(args); },
      debug: () => undefined,
      error: () => undefined,
      info: () => undefined,
    } as never,
    client as never,
    {} as never,
    persistence,
  );

  // Transient error during restore keeps tracking
  await manager.restoreFromDatabase("guild-1");
  assert.equal(manager.isTrackedTemporaryVc("vc-1"), true);
  assert.deepEqual(deletedIds, []);
  assert.equal(warns.length, 1);

  // Transient error during rename returns api_error and keeps tracking
  const renameErr = await manager.renameTemporaryVc("vc-1", { name: "新しいVC", actorUserId: "u1", actorTag: "u1" });
  assert.deepEqual(renameErr, { ok: false, error: "api_error" });
  assert.equal(manager.isTrackedTemporaryVc("vc-1"), true);
  assert.deepEqual(deletedIds, []);

  // Discord Unknown Channel (10003) removes tracking
  fetchBehavior = async () => {
    throw Object.assign(new Error("Unknown Channel"), { code: 10003 });
  };
  const renameMissing = await manager.renameTemporaryVc("vc-1", { name: "新しいVC", actorUserId: "u1", actorTag: "u1" });
  assert.deepEqual(renameMissing, { ok: false, error: "not_temporary_vc" });
  assert.equal(manager.isTrackedTemporaryVc("vc-1"), false);
  assert.deepEqual(deletedIds, ["vc-1"]);
});

test("restoreFromDatabase removes tracking only on 10003/404 and keeps tracking on 50001/50013/400/429/network errors", async () => {
  const deletedIds: string[] = [];
  const errorsByChannel = new Map<string, unknown>([
    ["vc-unknown", Object.assign(new Error("Unknown Channel"), { name: "DiscordAPIError[10003]", code: 10_003, status: 404 })],
    ["vc-404", Object.assign(new Error("Not Found"), { status: 404 })],
    ["vc-access", Object.assign(new Error("Missing Access"), { name: "DiscordAPIError[50001]", code: 50_001, status: 403 })],
    ["vc-perm", Object.assign(new Error("Missing Permissions"), { name: "DiscordAPIError[50013]", code: 50_013, status: 403 })],
    ["vc-bad-req", Object.assign(new Error("Bad Request"), { name: "DiscordAPIError[50035]", code: 50_035, status: 400 })],
    ["vc-rate", Object.assign(new Error("Too Many Requests"), { name: "DiscordAPIError[0]", code: 0, status: 429 })],
    ["vc-net", new Error("ECONNRESET")],
  ]);

  const client = {
    channels: {
      cache: new Map(),
      fetch: async (channelId: string) => {
        throw errorsByChannel.get(channelId);
      },
    },
  };
  const persistence = {
    listTracked: async () =>
      [...errorsByChannel.keys()].map((channelId) => ({
        channelId,
        guildId: "guild-1",
        createdAtMs: Date.now(),
        userEverJoined: false,
      })),
    deleteTracked: async (id: string) => {
      deletedIds.push(id);
    },
  } as unknown as VcTempPersistence;

  const manager = new VcTemporaryChannelManager(
    { warn: () => undefined, debug: () => undefined, error: () => undefined, info: () => undefined } as never,
    client as never,
    {} as never,
    persistence,
  );

  await manager.restoreFromDatabase("guild-1");

  assert.equal(manager.isTrackedTemporaryVc("vc-unknown"), false);
  assert.equal(manager.isTrackedTemporaryVc("vc-404"), false);
  assert.equal(manager.isTrackedTemporaryVc("vc-access"), true);
  assert.equal(manager.isTrackedTemporaryVc("vc-perm"), true);
  assert.equal(manager.isTrackedTemporaryVc("vc-bad-req"), true);
  assert.equal(manager.isTrackedTemporaryVc("vc-rate"), true);
  assert.equal(manager.isTrackedTemporaryVc("vc-net"), true);
  assert.deepEqual(deletedIds, ["vc-unknown", "vc-404"]);
});

test("fetchTrackedVoiceChannel warns once per channel and error code, downgrades repeats to debug, and resets after success", async () => {
  const warns: unknown[][] = [];
  const debugs: unknown[][] = [];
  let mode: "missing-access" | "ok" = "missing-access";

  const client = {
    channels: {
      cache: new Map(),
      fetch: async (channelId: string) => {
        if (mode === "missing-access") {
          throw Object.assign(new Error("Missing Access"), { name: "DiscordAPIError[50001]", code: 50_001, status: 403 });
        }
        return {
          id: channelId,
          type: ChannelType.GuildVoice,
          members: { size: 1 },
          setName: async () => undefined,
        };
      },
    },
  };
  const persistence = {
    listTracked: async () => [{ channelId: "vc-1", guildId: "guild-1", createdAtMs: Date.now(), userEverJoined: false }],
    deleteTracked: async () => undefined,
  } as unknown as VcTempPersistence;

  const manager = new VcTemporaryChannelManager(
    {
      warn: (...args: unknown[]) => { warns.push(args); },
      debug: (...args: unknown[]) => { debugs.push(args); },
      error: () => undefined,
      info: () => undefined,
    } as never,
    client as never,
    {} as never,
    persistence,
  );

  // First 50001 -> warn
  await manager.restoreFromDatabase("guild-1");
  assert.equal(warns.length, 1);
  assert.equal(debugs.length, 0);

  // Second 50001 on same channel -> debug (not warn)
  await manager.renameTemporaryVc("vc-1", { name: "テストVC", actorUserId: "u1", actorTag: "u1" });
  assert.equal(warns.length, 1);
  assert.equal(debugs.length, 1);

  // Success resets deduplication state
  mode = "ok";
  const okRes = await manager.renameTemporaryVc("vc-1", { name: "テストVC", actorUserId: "u1", actorTag: "u1" });
  assert.equal(okRes.ok, true);

  // Next 50001 after success -> warn again
  mode = "missing-access";
  await manager.renameTemporaryVc("vc-1", { name: "テストVC2", actorUserId: "u1", actorTag: "u1" });
  assert.equal(warns.length, 2);
  assert.equal(debugs.length, 1);
});

test("sweepTask reduces sweep frequency to 1/10 after 10 consecutive access-denied errors without detaching or deleting DB row, and recovers on success", async () => {
  const deletedIds: string[] = [];
  const warns: unknown[][] = [];
  const debugs: unknown[][] = [];
  let fetchCalls = 0;
  let mode: "50001" | "50013" | "403" | "503" | "429" | "network" | "ok" = "50001";

  const client = {
    channels: {
      cache: new Map(),
      fetch: async (channelId: string) => {
        fetchCalls += 1;
        if (mode === "50001") {
          throw Object.assign(new Error("Missing Access"), { name: "DiscordAPIError[50001]", code: 50_001, status: 403 });
        }
        if (mode === "50013") {
          throw Object.assign(new Error("Missing Permissions"), { name: "DiscordAPIError[50013]", code: 50_013, status: 403 });
        }
        if (mode === "403") {
          throw Object.assign(new Error("Forbidden"), { status: 403 });
        }
        if (mode === "503") {
          throw Object.assign(new Error("Service Unavailable"), { status: 503 });
        }
        if (mode === "429") {
          throw Object.assign(new Error("Too Many Requests"), { status: 429 });
        }
        if (mode === "network") {
          throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
        }
        return {
          id: channelId,
          type: ChannelType.GuildVoice,
          members: { size: 1 },
          setName: async () => undefined,
        };
      },
    },
  };
  const persistence = {
    listTracked: async () => [{ channelId: "vc-1", guildId: "guild-1", createdAtMs: Date.now(), userEverJoined: false }],
    deleteTracked: async (id: string) => {
      deletedIds.push(id);
    },
  } as unknown as VcTempPersistence;

  const manager = new VcTemporaryChannelManager(
    {
      warn: (...args: unknown[]) => { warns.push(args); },
      debug: (...args: unknown[]) => { debugs.push(args); },
      error: () => undefined,
      info: () => undefined,
    } as never,
    client as never,
    {} as never,
    persistence,
  );
  const runSweep = () => (manager as unknown as { sweepTask: () => Promise<void> }).sweepTask();

  // Access-denied on restoreFromDatabase and renameTemporaryVc must NOT increment counter
  await manager.restoreFromDatabase("guild-1");
  for (let i = 0; i < 15; i += 1) {
    const res = await manager.renameTemporaryVc("vc-1", { name: "テストVC", actorUserId: "u1", actorTag: "u1" });
    assert.deepEqual(res, { ok: false, error: "api_error" });
  }
  assert.equal(manager.isTrackedTemporaryVc("vc-1"), true);
  assert.deepEqual(deletedIds, []);

  // 5xx / 429 / network errors during sweepTask do not increment access-denied counter
  for (const transientMode of ["503", "429", "network"] as const) {
    mode = transientMode;
    for (let i = 0; i < 12; i += 1) {
      await runSweep();
    }
    assert.equal(manager.isTrackedTemporaryVc("vc-1"), true);
    assert.deepEqual(deletedIds, []);
  }

  // 5 sweep access-denied errors, then a non-access-denied failure (503) resets the consecutive counter
  mode = "50001";
  for (let i = 0; i < 5; i += 1) {
    await runSweep();
  }
  assert.equal(manager.isTrackedTemporaryVc("vc-1"), true);

  mode = "503";
  await runSweep();
  assert.equal(manager.isTrackedTemporaryVc("vc-1"), true);

  // 5 more access-denied errors must NOT enter backoff because 503 reset the consecutive count
  mode = "50001";
  for (let i = 0; i < 5; i += 1) {
    await runSweep();
  }
  const fetchBeforeNormalCheck = fetchCalls;
  await runSweep();
  assert.equal(fetchCalls, fetchBeforeNormalCheck + 1);

  // Success also resets the counter
  mode = "ok";
  const okRes = await manager.renameTemporaryVc("vc-1", { name: "テストVC", actorUserId: "u1", actorTag: "u1" });
  assert.equal(okRes.ok, true);

  // 9 consecutive sweep access-denied errors (mixing 50001, 50013, 403) keep normal sweep frequency
  for (let i = 0; i < 9; i += 1) {
    mode = i % 3 === 0 ? "50001" : i % 3 === 1 ? "50013" : "403";
    const before = fetchCalls;
    await runSweep();
    assert.equal(fetchCalls, before + 1);
    assert.equal(manager.isTrackedTemporaryVc("vc-1"), true);
  }

  // 10th consecutive sweep access-denied error logs warn once, keeps tracking & DB row, and enters 1/10 sweep backoff
  const warnCountBefore = warns.length;
  mode = "50001";
  await runSweep();
  assert.equal(manager.isTrackedTemporaryVc("vc-1"), true);
  assert.deepEqual(deletedIds, []);
  assert.equal(warns.length, warnCountBefore + 1);
  assert.match(String(warns[warns.length - 1]?.[1]), /reducing sweep frequency/);

  // Next 9 sweeps must skip fetch completely
  const fetchAfterLimit = fetchCalls;
  for (let i = 0; i < 9; i += 1) {
    await runSweep();
  }
  assert.equal(fetchCalls, fetchAfterLimit);

  // 10th sweep fetches once; still access denied -> no extra warn (debug only), and skips next 9 sweeps again
  const warnAfterLimit = warns.length;
  const debugBeforeThrottledFail = debugs.length;
  await runSweep();
  assert.equal(fetchCalls, fetchAfterLimit + 1);
  assert.equal(warns.length, warnAfterLimit);
  assert.equal(debugs.length, debugBeforeThrottledFail + 1);

  // Next 9 sweeps skipped again
  for (let i = 0; i < 9; i += 1) {
    await runSweep();
  }
  assert.equal(fetchCalls, fetchAfterLimit + 1);

  // Permissions restored: 10th sweep succeeds and restores normal sweep frequency
  mode = "ok";
  await runSweep();
  assert.equal(fetchCalls, fetchAfterLimit + 2);
  assert.equal(manager.isTrackedTemporaryVc("vc-1"), true);

  // Next sweep runs immediately without skipping
  await runSweep();
  assert.equal(fetchCalls, fetchAfterLimit + 3);
});

test("sweepTask and restoreFromDatabase remove tracking and log info when client is ready and guild is missing from cache, but skip check when client is not ready", async () => {
  // 1. client.isReady() === true and guild missing -> restoreFromDatabase removes tracking and logs info without fetching channel
  {
    const deletedIds: string[] = [];
    const infos: unknown[][] = [];
    let fetchCalls = 0;
    const client = {
      isReady: () => true,
      guilds: { cache: new Map<string, unknown>() },
      channels: {
        cache: new Map(),
        fetch: async () => {
          fetchCalls += 1;
          throw Object.assign(new Error("Missing Access"), { code: 50_001, status: 403 });
        },
      },
    };
    const persistence = {
      listTracked: async () => [{ channelId: "vc-left-restore", guildId: "guild-left", createdAtMs: Date.now(), userEverJoined: false }],
      deleteTracked: async (id: string) => {
        deletedIds.push(id);
      },
    } as unknown as VcTempPersistence;

    const manager = new VcTemporaryChannelManager(
      {
        warn: () => undefined,
        debug: () => undefined,
        error: () => undefined,
        info: (...args: unknown[]) => { infos.push(args); },
      } as never,
      client as never,
      {} as never,
      persistence,
    );

    await manager.restoreFromDatabase("guild-left");
    assert.equal(manager.isTrackedTemporaryVc("vc-left-restore"), false);
    assert.deepEqual(deletedIds, ["vc-left-restore"]);
    assert.equal(fetchCalls, 0);
    assert.equal(infos.length, 1);
    assert.match(String(infos[0]?.[1]), /guild not in cache/);
  }

  // 2. client.isReady() === true, guild initially present (50001 keeps tracking), then bot leaves guild -> sweepTask removes tracking and logs info
  {
    const deletedIds: string[] = [];
    const infos: unknown[][] = [];
    let fetchCalls = 0;
    const guildsCache = new Map<string, unknown>([["guild-1", { id: "guild-1" }]]);
    const client = {
      isReady: () => true,
      guilds: { cache: guildsCache },
      channels: {
        cache: new Map(),
        fetch: async () => {
          fetchCalls += 1;
          throw Object.assign(new Error("Missing Access"), { code: 50_001, status: 403 });
        },
      },
    };
    const persistence = {
      listTracked: async () => [{ channelId: "vc-left-sweep", guildId: "guild-1", createdAtMs: Date.now(), userEverJoined: false }],
      deleteTracked: async (id: string) => {
        deletedIds.push(id);
      },
    } as unknown as VcTempPersistence;

    const manager = new VcTemporaryChannelManager(
      {
        warn: () => undefined,
        debug: () => undefined,
        error: () => undefined,
        info: (...args: unknown[]) => { infos.push(args); },
      } as never,
      client as never,
      {} as never,
      persistence,
    );
    const runSweep = () => (manager as unknown as { sweepTask: () => Promise<void> }).sweepTask();

    await manager.restoreFromDatabase("guild-1");
    assert.equal(manager.isTrackedTemporaryVc("vc-left-sweep"), true);
    assert.deepEqual(deletedIds, []);

    // Guild is still in cache: 50001 keeps tracking
    await runSweep();
    assert.equal(manager.isTrackedTemporaryVc("vc-left-sweep"), true);
    assert.deepEqual(deletedIds, []);
    const fetchBeforeLeave = fetchCalls;

    // Bot is removed from guild -> next sweep removes tracking and DB row with info log
    guildsCache.delete("guild-1");
    await runSweep();
    assert.equal(manager.isTrackedTemporaryVc("vc-left-sweep"), false);
    assert.deepEqual(deletedIds, ["vc-left-sweep"]);
    assert.equal(fetchCalls, fetchBeforeLeave);
    assert.equal(infos.length, 1);
    assert.match(String(infos[0]?.[1]), /guild not in cache/);
  }

  // 3. client.isReady() === false (startup before guild cache is ready) -> does NOT remove tracking even if guilds.cache is empty
  {
    const deletedIds: string[] = [];
    const infos: unknown[][] = [];
    const client = {
      isReady: () => false,
      guilds: { cache: new Map<string, unknown>() },
      channels: {
        cache: new Map(),
        fetch: async () => {
          throw Object.assign(new Error("Missing Access"), { code: 50_001, status: 403 });
        },
      },
    };
    const persistence = {
      listTracked: async () => [{ channelId: "vc-not-ready", guildId: "guild-1", createdAtMs: Date.now(), userEverJoined: false }],
      deleteTracked: async (id: string) => {
        deletedIds.push(id);
      },
    } as unknown as VcTempPersistence;

    const manager = new VcTemporaryChannelManager(
      {
        warn: () => undefined,
        debug: () => undefined,
        error: () => undefined,
        info: (...args: unknown[]) => { infos.push(args); },
      } as never,
      client as never,
      {} as never,
      persistence,
    );
    const runSweep = () => (manager as unknown as { sweepTask: () => Promise<void> }).sweepTask();

    await manager.restoreFromDatabase("guild-1");
    assert.equal(manager.isTrackedTemporaryVc("vc-not-ready"), true);
    await runSweep();
    assert.equal(manager.isTrackedTemporaryVc("vc-not-ready"), true);
    assert.deepEqual(deletedIds, []);
    assert.equal(infos.length, 0);
  }
});

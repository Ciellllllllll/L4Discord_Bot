import assert from "node:assert/strict";
import {
  assignRoles,
  canUseRoleThreadAction,
  checkWinner,
  createInitialWerewolfState,
  parseWerewolfState,
  resolveVotes,
  roleCountsForPlayerCount,
  type WerewolfState,
} from "./werewolfState.js";

assert.throws(() => roleCountsForPlayerCount(4), /at least 5/);
assert.deepEqual(roleCountsForPlayerCount(0, { allowSmallGame: true }), { werewolf: 0, seer: 0, knight: 0, villager: 0 });
assert.deepEqual(roleCountsForPlayerCount(1, { allowSmallGame: true }), { werewolf: 1, seer: 0, knight: 0, villager: 0 });
assert.deepEqual(roleCountsForPlayerCount(2, { allowSmallGame: true }), { werewolf: 1, seer: 1, knight: 0, villager: 0 });
assert.deepEqual(roleCountsForPlayerCount(3, { allowSmallGame: true }), { werewolf: 1, seer: 1, knight: 1, villager: 0 });
assert.deepEqual(roleCountsForPlayerCount(4, { allowSmallGame: true }), { werewolf: 1, seer: 1, knight: 1, villager: 1 });
assert.deepEqual(roleCountsForPlayerCount(5), { werewolf: 1, seer: 1, knight: 1, villager: 2 });
assert.deepEqual(roleCountsForPlayerCount(8), { werewolf: 2, seer: 1, knight: 1, villager: 4 });
assert.deepEqual(roleCountsForPlayerCount(12), { werewolf: 3, seer: 1, knight: 2, villager: 6 });
assert.deepEqual(roleCountsForPlayerCount(16), { werewolf: 4, seer: 2, knight: 2, villager: 8 });
assert.equal(assignRoles(["u1"], () => 0, { allowSmallGame: true })[0]?.role, "werewolf");

const base = createInitialWerewolfState({ channelId: "channel1", hostId: "host1" });
const state: WerewolfState = {
  ...base,
  phase: "night",
  players: [
    { userId: "wolf1", role: "werewolf", alive: true },
    { userId: "seer1", role: "seer", alive: true },
    { userId: "knight1", role: "knight", alive: true },
    { userId: "v1", role: "villager", alive: true },
    { userId: "v2", role: "villager", alive: false },
  ],
  rolePrivateThreadIds: { werewolf: "thread-wolf", seer: "thread-seer", knight: "thread-knight" },
  roleThreadMembersByRole: { werewolf: ["wolf1"], seer: ["seer1"], knight: ["knight1"] },
};
const parsed = parseWerewolfState(JSON.stringify(state));
assert.equal(parsed?.rolePrivateThreadIds.werewolf, "thread-wolf");
assert.deepEqual(parsed?.roleThreadMembersByRole.seer, ["seer1"]);

assert.equal(
  canUseRoleThreadAction({
    state,
    userId: "wolf1",
    role: "werewolf",
    channelId: "thread-wolf",
    phase: "night",
    targetUserId: "v1",
  }),
  true,
);
assert.equal(
  canUseRoleThreadAction({
    state,
    userId: "seer1",
    role: "werewolf",
    channelId: "thread-wolf",
    phase: "night",
    targetUserId: "v1",
  }),
  false,
);
assert.equal(
  canUseRoleThreadAction({
    state,
    userId: "v2",
    role: "werewolf",
    channelId: "thread-wolf",
    phase: "night",
    targetUserId: "v1",
  }),
  false,
);
assert.equal(
  canUseRoleThreadAction({
    state,
    userId: "wolf1",
    role: "werewolf",
    channelId: "thread-seer",
    phase: "night",
    targetUserId: "v1",
  }),
  false,
);
assert.equal(
  canUseRoleThreadAction({
    state: { ...state, phase: "voting" },
    userId: "wolf1",
    role: "werewolf",
    channelId: "thread-wolf",
    phase: "night",
    targetUserId: "v1",
  }),
  false,
);

assert.equal(resolveVotes({ wolf1: "v1", seer1: "wolf1" }, ["wolf1", "seer1", "v1"]), null);
assert.equal(resolveVotes({ wolf1: "v1", seer1: "v1", knight1: "wolf1" }, ["wolf1", "seer1", "knight1", "v1"]), "v1");

assert.equal(checkWinner([{ userId: "v1", role: "villager", alive: true }]), "villagers");
assert.equal(
  checkWinner([
    { userId: "w1", role: "werewolf", alive: true },
    { userId: "v1", role: "villager", alive: true },
  ]),
  "werewolves",
);
assert.equal(
  checkWinner([
    { userId: "w1", role: "werewolf", alive: true },
    { userId: "v1", role: "villager", alive: true },
    { userId: "v2", role: "villager", alive: true },
  ]),
  null,
);

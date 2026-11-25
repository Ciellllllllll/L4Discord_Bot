import assert from "node:assert/strict";
import test from "node:test";
import { TtlStore } from "./ttlStore.js";

test("TtlStore.has respects TTL and evicts expired entries", () => {
  let currentTime = 1_000;
  const store = new TtlStore<string>(500, () => currentTime);

  store.set("k1", "v1");
  assert.equal(store.has("k1"), true);

  currentTime = 1_500;
  assert.equal(store.has("k1"), true);

  currentTime = 1_501;
  assert.equal(store.has("k1"), false);
  assert.equal(store.get("k1"), null);
});

test("TtlStore.touch does not resurrect expired entries", () => {
  let currentTime = 1_000;
  const store = new TtlStore<string>(500, () => currentTime);

  store.set("k1", "v1");
  currentTime = 1_501;
  store.touch("k1");
  assert.equal(store.has("k1"), false);
});

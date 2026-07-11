import assert from "node:assert/strict";
import { initializeRuntimeHandlersWithCleanup } from "./registerWithCleanup.js";

const calls: string[] = [];
await assert.rejects(
  () => initializeRuntimeHandlersWithCleanup({
    registerHandlers: async () => { throw new Error("kuromoji unavailable"); },
    closeDatabase: async () => { calls.push("database"); },
    destroyClient: () => { calls.push("client"); },
    warn: () => undefined,
  }),
  /kuromoji unavailable/,
);
assert.deepEqual(calls, ["database", "client"]);

console.log("registerWithCleanup.spec.ts: all assertions passed");

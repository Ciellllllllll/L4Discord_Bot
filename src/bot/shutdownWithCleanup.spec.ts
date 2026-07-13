import assert from "node:assert/strict";
import { test } from "node:test";
import { shutdownWithCleanup } from "./shutdownWithCleanup.js";

test("shutdown runs database cleanup and logs both failures when handler shutdown fails", async () => {
  const calls: string[] = [];

  await assert.rejects(
    shutdownWithCleanup({
      shutdownHandlers: async () => { calls.push("handlers"); throw new Error("handlers failed"); },
      closeDatabase: async () => { calls.push("database"); throw new Error("database failed"); },
      warn: (_error, message) => { calls.push(message); },
    }),
    /handlers failed/,
  );

  assert.deepEqual(calls, [
    "handlers",
    "runtime handler shutdown failed",
    "database",
    "database runtime shutdown failed",
  ]);
});

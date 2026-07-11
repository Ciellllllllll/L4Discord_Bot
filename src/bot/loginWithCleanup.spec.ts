import assert from "node:assert/strict";
import { test } from "node:test";
import { loginWithCleanup } from "./loginWithCleanup.js";

test("login failure shuts down handlers then closes database without hiding the login error", async () => {
  const calls: string[] = [];
  const loginError = new Error("login failed");

  await assert.rejects(
    loginWithCleanup({
      login: async () => { calls.push("login"); throw loginError; },
      shutdownHandlers: async () => { calls.push("handlers"); },
      closeDatabase: async () => { calls.push("database"); throw new Error("database close failed"); },
      warn: () => { calls.push("warn"); },
    }),
    (error: unknown) => error === loginError,
  );

  assert.deepEqual(calls, ["login", "handlers", "database", "warn"]);
});

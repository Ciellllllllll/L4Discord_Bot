import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("index delegates database and Discord event lifecycles to runtime modules", async () => {
  const source = await readFile(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");

  assert.match(source, /createDatabaseRuntime\(config, log\)/);
  assert.match(source, /registerRuntimeHandlers\(ctx\)/);
  assert.doesNotMatch(source, /\/\*\s*const db\s*=/);
  assert.doesNotMatch(source, /client\.(?:on|once)\(/);
});

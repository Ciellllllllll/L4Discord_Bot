import assert from "node:assert/strict";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  ColdLaughHandler,
  coldLaughHitsForMessageContent,
  stripLinksForColdLaughContent,
} from "./coldLaugh.js";

assert.equal(coldLaughHitsForMessageContent("https://example.com/落ち着けw"), 0);
assert.equal(coldLaughHitsForMessageContent("x.com/user/status/123/落ち着けw"), 0);
assert.equal(coldLaughHitsForMessageContent("youtu.be/怒んなやw"), 0);
assert.equal(coldLaughHitsForMessageContent("notyoutube.com/watch?v=落ち着けw"), 2);
assert.equal(coldLaughHitsForMessageContent("落ち着けw https://example.com/post"), 2);
assert.equal(stripLinksForColdLaughContent("see youtu.be/落ち着けw now").trim(), "see   now");

let reply = "";
const storePath = path.join(tmpdir(), `l4-cold-laugh-${randomUUID()}.json`);
const handler = new ColdLaughHandler({
  config: { COLD_LAUGH_STORE_PATH: storePath, GUILD_ID: "guild-1" },
  db: {
    selectFrom: () => ({
      selectAll: () => ({
        where: () => ({
          executeTakeFirst: async () => ({ guild_id: "guild-1", data: "{}" }),
        }),
      }),
    }),
  },
  log: { error() {}, warn() {} },
} as never);
await handler.onMessage({
  author: { bot: false, id: "user-1" },
  guild: { id: "guild-1" },
  channelId: "channel-1",
  content: "落ち着けw",
  reply: async (payload: { content: string }) => { reply = payload.content; },
} as never);
assert.match(reply, /2 回/);
if (existsSync(storePath)) unlinkSync(storePath);

console.log("coldLaugh.spec.ts: all assertions passed");

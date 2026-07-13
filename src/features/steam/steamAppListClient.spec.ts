import assert from "node:assert/strict";
import type pino from "pino";
import { SteamAppListClient } from "./steamAppListClient.js";

async function run() {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  const warnings: unknown[] = [];

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    requestedUrls.push(input.toString());
    if (requestedUrls.length === 1) {
      return new Response("rate limited", {
        status: 429,
        headers: { "Retry-After": "0" },
      });
    }
    return Response.json({
      response: {
        apps: [{ appid: 10, name: "Paid Game", last_modified: 100, price_change_number: 2 }],
      },
    });
  }) as typeof fetch;

  try {
    const client = new SteamAppListClient({
      info() {},
      warn(fields: unknown) {
        warnings.push(fields);
      },
    } as unknown as pino.Logger);
    const apps = await client.fetchAllApps();
    assert.equal(requestedUrls.length, 2);
    assert.equal(warnings.length, 1);
    assert.deepEqual(apps, [
      {
        appid: "10",
        name: "Paid Game",
        lastModified: 100,
        priceChangeNumber: 2,
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

run()
  .then(() => {
    console.log("steamAppListClient.spec.ts: all assertions passed");
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });

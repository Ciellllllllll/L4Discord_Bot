import assert from "node:assert/strict";
import { buildPacchiPoemCandidates, buildVerifiedPacchiPoem, pacchiVerifiedPoemFailureMessage } from "./pacchi.poem.js";

function responseJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function run(): Promise<void> {
  const candidates = buildPacchiPoemCandidates("575", ["コード"]);
  assert.ok(candidates.length > 0);
  assert.match(candidates[0]!, /コード/);
  assert.deepEqual(buildPacchiPoemCandidates("777", ["コード"]), []);

  const calls: string[] = [];
  const matched = await buildVerifiedPacchiPoem("575", ["コード"], {
    baseUrl: "http://127.0.0.1:8787",
    timeoutMs: 100,
    fetchImpl: async (_input, init) => {
      calls.push(String(init?.body));
      return responseJson({
        matched: calls.length === 2,
        text: calls.length === 2 ? "春風に コードが揺れて バグが咲く" : null,
        phrases: calls.length === 2 ? ["春風に", "コードが揺れて", "バグが咲く"] : [],
        error: null,
      });
    },
  });
  assert.equal(matched.ok, true);
  assert.equal(matched.ok ? matched.poem : "", "春風に\nコードが揺れて\nバグが咲く");
  assert.equal(calls.length, 2);

  const invalid = await buildVerifiedPacchiPoem("777", ["コード"], {
    baseUrl: "http://127.0.0.1:8787",
    timeoutMs: 100,
    fetchImpl: async () => {
      throw new Error("should not call worker");
    },
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.ok ? "" : invalid.reason, "invalid_pattern");
  assert.match(invalid.ok ? "" : pacchiVerifiedPoemFailureMessage(invalid), /pacchi_poem 575/);

  const workerFailed = await buildVerifiedPacchiPoem("575", ["コード"], {
    baseUrl: "http://127.0.0.1:8787",
    timeoutMs: 100,
    fetchImpl: async () => responseJson({ error: "bad" }, 500),
  });
  assert.equal(workerFailed.ok, false);
  assert.equal(workerFailed.ok ? "" : workerFailed.reason, "worker_failed");
}

void run()
  .then(() => {
    console.log("pacchi.poem.spec.ts: all assertions passed");
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

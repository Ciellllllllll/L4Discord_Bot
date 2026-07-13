import assert from "node:assert/strict";
import { AiRequestError } from "./aiRequestError.js";
import { OpenAiUsageClient } from "./openaiUsage.js";

async function run(): Promise<void> {
  let nowMs = Date.parse("2026-07-10T12:34:56.000Z");
  const urls: URL[] = [];
  let calls = 0;
  const client = new OpenAiUsageClient(
    {
      adminKey: "admin-secret",
      apiBase: "https://api.openai.test/v1/",
      projectId: "proj_bot",
      cacheMs: 30_000,
      timeoutMs: 10_000,
      maxResponseBytes: 64_000,
    },
    {
      now: () => nowMs,
      fetcher: async (url) => {
        calls += 1;
        const parsed = new URL(url);
        urls.push(parsed);
        if (!parsed.searchParams.get("page")) {
          return Response.json({
            data: [{
              results: [
                {
                  input_tokens: 100,
                  output_tokens: 25,
                  input_cached_tokens: 80,
                  model: "gpt-5.6-terra",
                  project_id: "proj_bot",
                },
                {
                  input_tokens: 200,
                  output_tokens: 50,
                  model: "gpt-5.6-luna",
                  project_id: "proj_other",
                },
                {
                  input_tokens: 999,
                  output_tokens: 1,
                  model: "gpt-5.6-sol",
                  project_id: "proj_other",
                },
              ],
            }],
            has_more: true,
            next_page: "next-token",
          });
        }
        return Response.json({
          data: [{
            results: [{
              input_tokens: 300,
              output_tokens: 75,
              model: "gpt-5.4-mini-2026-03-17",
              project_id: "proj_other",
            }],
          }],
          has_more: false,
          next_page: null,
        });
      },
    },
  );

  const [first, coalesced] = await Promise.all([client.getTodaySnapshot(), client.getTodaySnapshot()]);
  assert.deepEqual(first, {
    usageDate: "2026-07-10",
    organizationTokens: 750,
    botProjectTokens: 125,
  });
  assert.deepEqual(coalesced, first);
  assert.equal(calls, 2);
  assert.equal(urls[0]?.pathname, "/v1/organization/usage/completions");
  assert.equal(urls[0]?.searchParams.get("start_time"), String(Date.parse("2026-07-10T00:00:00.000Z") / 1000));
  assert.equal(urls[0]?.searchParams.get("end_time"), String(nowMs / 1000));
  assert.deepEqual(urls[0]?.searchParams.getAll("group_by"), ["model", "project_id"]);
  assert.equal(urls[1]?.searchParams.get("page"), "next-token");

  assert.deepEqual(await client.getTodaySnapshot(), first);
  assert.equal(calls, 2, "fresh snapshot should be cached");

  nowMs += 30_001;
  await client.getTodaySnapshot();
  assert.equal(calls, 4, "expired snapshot should be fetched again");

  const missingAdmin = new OpenAiUsageClient({
    adminKey: "",
    apiBase: "https://api.openai.test/v1",
    projectId: "proj_bot",
    cacheMs: 0,
    timeoutMs: 10_000,
    maxResponseBytes: 64_000,
  });
  await assert.rejects(
    missingAdmin.getTodaySnapshot(),
    (err: unknown) => err instanceof AiRequestError && err.kind === "configuration",
  );

  const failed = new OpenAiUsageClient(
    {
      adminKey: "admin-secret",
      apiBase: "https://api.openai.test/v1",
      projectId: "proj_bot",
      cacheMs: 0,
      timeoutMs: 10_000,
      maxResponseBytes: 64_000,
    },
    { fetcher: async () => Response.json({}, { status: 429 }) },
  );
  await assert.rejects(
    failed.getTodaySnapshot(),
    (err: unknown) => err instanceof AiRequestError && err.kind === "http_status" && err.status === 429,
  );
}

void run()
  .then(() => console.log("openaiUsage.spec.ts: all assertions passed"))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

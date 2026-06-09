import assert from "node:assert/strict";
import { parsePacchiAiFinalCheckVerdict } from "./pacchi.aiFinalCheck.js";

async function run(): Promise<void> {
  assert.equal(parsePacchiAiFinalCheckVerdict('{"verdict":"accept"}'), "accept");
  assert.equal(parsePacchiAiFinalCheckVerdict("```json\n{\"verdict\":\"reject\"}\n```"), "reject");
  assert.equal(parsePacchiAiFinalCheckVerdict('{"verdict":"maybe"}'), null);
  assert.equal(parsePacchiAiFinalCheckVerdict("not json"), null);
}

void run()
  .then(() => {
    console.log("pacchi.aiFinalCheck.spec.ts: all assertions passed");
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

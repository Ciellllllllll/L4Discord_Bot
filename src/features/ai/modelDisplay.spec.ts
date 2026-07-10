import assert from "node:assert/strict";
import { sanitizeAiModelName } from "./modelDisplay.js";

const unsafe = `unsafe\`\r\n@everyone **<@123>** ${"x".repeat(150)}`;
const sanitized = sanitizeAiModelName(unsafe);

assert.equal(/[\r\n`*@<>]/.test(sanitized), false);
assert.ok(sanitized.length <= 120);
assert.equal(sanitizeAiModelName(""), "不明");
assert.equal(sanitizeAiModelName("gpt-5.4-mini-2026-03-17"), "gpt-5.4-mini-2026-03-17");

console.log("modelDisplay.spec.ts: all assertions passed");

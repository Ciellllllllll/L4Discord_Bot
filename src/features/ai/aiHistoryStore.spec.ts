import assert from "node:assert/strict";
import { test } from "node:test";
import { trimOptimizerWindow } from "./aiHistoryStore.js";

test("trimOptimizerWindow excludes r18/local_llm rows and keeps user/assistant pairs intact for odd maxRows", () => {
  const rows = [
    { role: "user", content: "q1", meta: { provider: "openai" } },
    { role: "assistant", content: "a1", meta: { provider: "openai" } },
    { role: "user", content: "q2", meta: { provider: "deepseek" } },
    { role: "assistant", content: "a2", meta: { provider: "deepseek" } },
    { role: "user", content: "r18q", meta: { r18: true, provider: "local_llm" } },
    { role: "assistant", content: "r18a", meta: { r18: true, provider: "local_llm" } },
  ];

  // maxRows = 3 (odd) should align to 2 (1 full pair), not split user/assistant
  assert.deepEqual(trimOptimizerWindow(rows, 3), [
    { role: "user", content: "q2" },
    { role: "assistant", content: "a2" },
  ]);

  // maxRows = 4 returns both non-r18 pairs
  assert.deepEqual(trimOptimizerWindow(rows, 4), [
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "q2" },
    { role: "assistant", content: "a2" },
  ]);

  // Leading orphan assistant is dropped
  assert.deepEqual(
    trimOptimizerWindow(
      [
        { role: "assistant", content: "orphan", meta: {} },
        { role: "user", content: "q1", meta: {} },
        { role: "assistant", content: "a1", meta: {} },
      ],
      2,
    ),
    [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
    ],
  );

  // maxRows = 1 clamps to minimum 2 (keeps at least the most recent 1 pair)
  assert.deepEqual(trimOptimizerWindow(rows, 1), [
    { role: "user", content: "q2" },
    { role: "assistant", content: "a2" },
  ]);

  // maxRows <= 0 returns empty
  assert.deepEqual(trimOptimizerWindow(rows, 0), []);

  // Legacy JSON-string meta rows are excluded before slicing
  const rowsWithLegacy = [
    ...rows.slice(0, 4),
    { role: "user", content: "legacy-q", meta: JSON.stringify({ r18: true }) },
    { role: "assistant", content: "legacy-a", meta: JSON.stringify({ provider: "local_llm" }) },
  ];
  assert.deepEqual(trimOptimizerWindow(rowsWithLegacy, 4), [
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "q2" },
    { role: "assistant", content: "a2" },
  ]);
});

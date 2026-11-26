import assert from "node:assert/strict";
import { extractJson, removeTrailingCommas } from "./deepseekJson.mjs";

// 正しい JSON はそのまま解析する
assert.deepEqual(extractJson('{"summary":"ok","comments":[]}'), { summary: "ok", comments: [] });

// オブジェクト・配列の末尾カンマを取り除いて解析する（実際に失敗した応答の形）
{
  const text = [
    "{",
    '  "summary": "総評",',
    '  "risk_level": "low",',
    '  "comments": [',
    "    {",
    '      "path": "src/a.ts",',
    '      "line": 1,',
    '      "severity": "minor",',
    '      "title": "t",',
    '      "body": "b",',
    "    },",
    "  ]",
    "}",
  ].join("\n");
  assert.equal(extractJson(text).comments[0].body, "b");
}

// 文字列の中のカンマや括弧は変更しない
assert.equal(
  removeTrailingCommas('{"body":"a, }\\", ]",}'),
  '{"body":"a, }\\", ]"}',
);

// 前後に説明文やコードフェンスがあっても、外側の波括弧から取り出す
assert.deepEqual(extractJson('結果です\n```json\n{"a":1,}\n```'), { a: 1 });

// 本文にコードブロックを含んでいても途中で切れない
assert.deepEqual(
  extractJson('```json\n{"body":"例:\\n```ts\\nx\\n```"}\n```'),
  { body: "例:\n```ts\nx\n```" },
);

// 修復できない場合は、エラー位置の前後を含めて失敗させる
assert.throws(
  () => extractJson('{"a": 1 "b": 2}'),
  (error) => /not valid JSON/.test(error.message) && /near:/.test(error.message),
);

// JSON が含まれない場合
assert.throws(() => extractJson("no json"), /did not contain JSON/);

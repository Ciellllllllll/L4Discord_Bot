import assert from "node:assert/strict";
import { readDeepSeekStream } from "./deepseekStream.mjs";

/** 文字列の断片を順に流す Response を作る（チャンク境界が行の途中にあるケースを再現する）。 */
function streamResponse(parts) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  }));
}

const event = (value) => `data: ${JSON.stringify(value)}\n\n`;

// 推論の差分は無視し、本文だけを連結する。キープアライブや [DONE] も読み飛ばす
{
  const body = [
    ": keep-alive\n\n",
    event({ choices: [{ delta: { reasoning_content: "考え中" } }] }),
    event({ choices: [{ delta: { content: "{\"summary\":" } }] }),
    event({ choices: [{ delta: { content: "\"ok\"}" }, finish_reason: "stop" }] }),
    event({ choices: [], usage: { completion_tokens: 10, completion_tokens_details: { reasoning_tokens: 7 } } }),
    "data: [DONE]\n\n",
  ].join("");
  // 行の途中・マルチバイト文字の途中で分割しても正しく組み立てる
  const bytes = new TextEncoder().encode(body);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 7) chunks.push(bytes.slice(i, i + 7));
  const result = await readDeepSeekStream(new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  })));
  assert.equal(result.content, "{\"summary\":\"ok\"}");
  assert.equal(result.finishReason, "stop");
  assert.equal(result.usage.completion_tokens_details.reasoning_tokens, 7);
}

// CRLF 区切りでも読める
{
  const result = await readDeepSeekStream(streamResponse([
    "data: {\"choices\":[{\"delta\":{\"content\":\"a\"},\"finish_reason\":\"stop\"}]}\r\n\r\n",
  ]));
  assert.equal(result.content, "a");
  assert.equal(result.finishReason, "stop");
}

// 推論だけで上限に達した場合は、本文が空で finish_reason=length になる
{
  const result = await readDeepSeekStream(streamResponse([
    event({ choices: [{ delta: { reasoning_content: "長い推論" } }] }),
    event({ choices: [{ delta: {}, finish_reason: "length" }] }),
  ]));
  assert.equal(result.content, "");
  assert.equal(result.finishReason, "length");
}

// 終了理由が届く前に接続が閉じた場合は finishReason が null のまま返る（呼び出し側で失敗扱いにする）
{
  const result = await readDeepSeekStream(streamResponse([
    event({ choices: [{ delta: { content: "{\"summary\":\"途中\"}" } }] }),
  ]));
  assert.equal(result.content, "{\"summary\":\"途中\"}");
  assert.equal(result.finishReason, null);
}

// ストリーム中のエラーは例外にする
await assert.rejects(
  readDeepSeekStream(streamResponse([event({ error: { message: "overloaded" } })])),
  /DeepSeek stream error/,
);

// 最後の行に改行がなくても取りこぼさない
{
  const result = await readDeepSeekStream(streamResponse([
    "data: {\"choices\":[{\"delta\":{\"content\":\"end\"},\"finish_reason\":\"stop\"}]}",
  ]));
  assert.equal(result.content, "end");
}

console.log("deepseekStream.spec.mjs: all assertions passed");

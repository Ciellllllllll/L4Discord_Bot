/** Server-Sent Events 形式のストリーミング応答から、本文・終了理由・使用量を組み立てる。 */
export async function readDeepSeekStream(response) {
  if (!response.body) {
    throw new Error("DeepSeek returned no response body.");
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let finishReason = null;
  let usage = null;

  const handleLine = (line) => {
    // 空行とキープアライブのコメント行（": keep-alive"）は無視する
    if (!line.startsWith("data:")) return;
    const data = line.slice("data:".length).trim();
    if (!data || data === "[DONE]") return;
    const chunk = JSON.parse(data);
    if (chunk.error) {
      throw new Error(`DeepSeek stream error: ${JSON.stringify(chunk.error)}`);
    }
    const choice = chunk.choices?.[0];
    if (typeof choice?.delta?.content === "string") content += choice.delta.content;
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk.usage) usage = chunk.usage;
  };

  for await (const bytes of response.body) {
    buffer += decoder.decode(bytes, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      handleLine(buffer.slice(0, newline).replace(/\r$/, ""));
      buffer = buffer.slice(newline + 1);
    }
  }
  buffer += decoder.decode();
  if (buffer) handleLine(buffer.replace(/\r$/, ""));

  return { content, finishReason, usage };
}

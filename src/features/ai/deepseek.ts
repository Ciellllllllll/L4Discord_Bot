import type { AppConfig } from "../../core/config.js";

const DEFAULT_BASE = "https://api.deepseek.com/v1";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type DeepSeekResult = {
  content: string;
  ms: number;
};

export async function deepseekChat(
  config: AppConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<DeepSeekResult> {
  const base = (config.DEEPSEEK_API_BASE ?? DEFAULT_BASE).replace(/\/$/, "");
  const url = `${base}/chat/completions`;
  const started = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages,
    }),
    signal,
  });
  const ms = Date.now() - started;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DeepSeek HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = body.choices?.[0]?.message?.content?.trim() ?? "";
  return { content, ms };
}

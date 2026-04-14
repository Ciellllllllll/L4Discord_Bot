import type { AppConfig } from "../../core/config.js";
import { fetchWithLimits } from "./fetchWithLimits.js";

const DEFAULT_BASE = "https://api.deepseek.com/v1";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type DeepSeekResult = {
  content: string;
  ms: number;
};

export type DeepSeekRequestOptions = {
  signal?: AbortSignal;
  temperature?: number;
  model?: string;
    // false のとき @everyone 等のサニタイズをしない（分類器など）

  sanitizeOutput?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
};

function sanitizeAiText(text: string): string {
  return String(text || "")
    .trim()
    .replace(/@everyone/g, "@\u200beveryone")
    .replace(/@here/g, "@\u200bhere");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// DeepSeek（OpenAI 互換）chat completions。`third` に AbortSignal かオプションオブジェクトを渡せる。
// レスポンスサイズは AI_MAX_RESPONSE_BYTES で制限（fetchWithLimits）。

export async function deepseekChat(
  config: AppConfig,
  messages: ChatMessage[],
  third?: AbortSignal | DeepSeekRequestOptions,
): Promise<DeepSeekResult> {
  const options: DeepSeekRequestOptions =
    third instanceof AbortSignal ? { signal: third } : { ...(third ?? {}) };

  const base = (config.DEEPSEEK_API_BASE ?? DEFAULT_BASE).replace(/\/$/, "");
  const url = `${base}/chat/completions`;
  const model = options.model ?? config.DEEPSEEK_MODEL;
  const temperature = options.temperature ?? config.AI_TEMPERATURE;
  const timeoutMs = options.timeoutMs ?? config.AI_REQUEST_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? config.AI_MAX_RETRIES;
  const sanitize = options.sanitizeOutput !== false;
  const maxResponseBytes = config.AI_MAX_RESPONSE_BYTES;

  const startedTotal = Date.now();
  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const res = await fetchWithLimits(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.DEEPSEEK_API_KEY}`,
          },
          body: JSON.stringify({
            model,
            temperature,
            messages,
          }),
        },
        {
          timeoutMs,
          maxResponseBytes,
          outerSignal: options.signal,
        },
      );

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`DeepSeek HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const body = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const raw = body.choices?.[0]?.message?.content?.trim() ?? "";
      const content = sanitize ? sanitizeAiText(raw) : raw;
      return { content, ms: Date.now() - startedTotal };
    } catch (e) {
      lastErr = e;
      if (attempt < maxRetries) {
        await sleep(400 * (attempt + 1));
      }
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error("DeepSeek request failed");
}

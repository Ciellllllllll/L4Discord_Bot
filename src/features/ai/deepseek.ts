import type { AppConfig } from "../../core/config.js";
import { fetchWithLimits } from "./fetchWithLimits.js";
import { type ChatMessage, sanitizeAiText } from "./chatTypes.js";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_BASE = "https://api.deepseek.com";

export type { ChatMessage } from "./chatTypes.js";

export type DeepSeekResult = {
  content: string;
  ms: number;
  model: string;
};

export type DeepSeekRequestOptions = {
  signal?: AbortSignal;
  temperature?: number;
  model?: string;
  thinking?: boolean;
  reasoningEffort?: "high" | "max";
    // false のとき @everyone 等のサニタイズをしない（分類器など）

  sanitizeOutput?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
};

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
  const thinking = options.thinking ?? config.DEEPSEEK_THINKING_ENABLED;
  const reasoningEffort = options.reasoningEffort ?? config.DEEPSEEK_THINKING_EFFORT;
  const apiKey = config.DEEPSEEK_API_KEY.trim();
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY is not set. Set it in .env to use AI features.");
  }
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
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            ...(thinking ? { reasoning_effort: reasoningEffort } : { temperature }),
            thinking: { type: thinking ? "enabled" : "disabled" },
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
        await res.text();
        throw new Error(`DeepSeek HTTP ${res.status}`);
      }
      let body: {
        model?: unknown;
        choices?: Array<{ message?: { content?: string } }>;
      };
      try {
        body = await res.json() as typeof body;
      } catch {
        throw new Error("DeepSeek returned invalid JSON");
      }
      const raw = body.choices?.[0]?.message?.content?.trim() ?? "";
      const content = sanitize ? sanitizeAiText(raw) : raw;
      const responseModel = typeof body.model === "string" && body.model.trim()
        ? body.model.trim()
        : model;
      return { content, ms: Date.now() - startedTotal, model: responseModel };
    } catch (e) {
      lastErr = e;
      if (attempt < maxRetries) {
        await delay(400 * (attempt + 1));
      }
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error("DeepSeek request failed");
}

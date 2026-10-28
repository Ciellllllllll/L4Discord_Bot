import { setTimeout as delay } from "node:timers/promises";
import type { AppConfig } from "../../core/config.js";
import { AiRequestError } from "./aiRequestError.js";
import { type ChatMessage, sanitizeAiText } from "./chatTypes.js";
import { fetchWithLimits } from "./fetchWithLimits.js";

const DEFAULT_BASE = "https://openrouter.ai/api/v1";

export type OpenRouterRequestOptions = {
  signal?: AbortSignal;
  temperature?: number;
  timeoutMs?: number;
  maxRetries?: number;
  // false のとき @everyone 等のサニタイズをしない（分類器など）
  sanitizeOutput?: boolean;
};

export type OpenRouterResult = {
  content: string;
  ms: number;
  model: string;
  usageTotalTokens?: number;
};

type OpenRouterConfig = Pick<
  AppConfig,
  | "OPENROUTER_API_KEY"
  | "OPENROUTER_API_BASE"
  | "OPENROUTER_MODEL"
  | "AI_TEMPERATURE"
  | "AI_REQUEST_TIMEOUT_MS"
  | "AI_MAX_RESPONSE_BYTES"
  | "AI_MAX_RETRIES"
>;

function classifyFetchError(error: unknown, signal?: AbortSignal): AiRequestError {
  if (error instanceof AiRequestError) return error;
  if (signal?.aborted) {
    return new AiRequestError("caller_abort", "AI request was cancelled.", { cause: error });
  }
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new AiRequestError("timeout", "OpenRouter request timed out.", { cause: error });
  }
  return new AiRequestError("network", "OpenRouter request failed.", { cause: error });
}

// OpenRouter（OpenAI 互換）chat completions。
// 使用モデルは OPENROUTER_MODEL（例: openai/gpt-4.1-mini）で指定する。
export async function openRouterChat(
  config: OpenRouterConfig,
  messages: ChatMessage[],
  options: OpenRouterRequestOptions = {},
): Promise<OpenRouterResult> {
  const apiKey = config.OPENROUTER_API_KEY.trim();
  if (!apiKey) {
    throw new AiRequestError(
      "configuration",
      "OPENROUTER_API_KEY is not set. Set it in .env to use OpenRouter.",
    );
  }

  const base = (config.OPENROUTER_API_BASE || DEFAULT_BASE).replace(/\/+$/, "");
  const url = `${base}/chat/completions`;
  const model = config.OPENROUTER_MODEL;
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
            temperature,
            messages,
          }),
        },
        {
          timeoutMs,
          maxResponseBytes,
          outerSignal: options.signal,
        },
      ).catch((error: unknown) => {
        throw classifyFetchError(error, options.signal);
      });

      if (!res.ok) {
        await res.text();
        throw new AiRequestError("http_status", `OpenRouter HTTP ${res.status}`, { status: res.status });
      }

      let body: {
        model?: unknown;
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { total_tokens?: unknown };
      };
      try {
        body = await res.json() as typeof body;
      } catch {
        throw new AiRequestError("invalid_response", "OpenRouter returned invalid JSON");
      }

      const raw = body.choices?.[0]?.message?.content?.trim() ?? "";
      const content = sanitize ? sanitizeAiText(raw) : raw;
      const responseModel = typeof body.model === "string" && body.model.trim()
        ? body.model.trim()
        : model;
      const usageTotalTokens = typeof body.usage?.total_tokens === "number"
        ? body.usage.total_tokens
        : undefined;
      return {
        content,
        ms: Date.now() - startedTotal,
        model: responseModel,
        ...(usageTotalTokens === undefined ? {} : { usageTotalTokens }),
      };
    } catch (e) {
      lastErr = e;
      if (e instanceof AiRequestError && e.kind === "caller_abort") throw e;
      if (attempt < maxRetries) {
        await delay(400 * (attempt + 1));
      }
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error("OpenRouter request failed");
}

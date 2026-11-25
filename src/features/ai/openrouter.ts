import type { AppConfig } from "../../core/config.js";
import { AiRequestError } from "./aiRequestError.js";
import { type ChatMessage, sanitizeAiText } from "./chatTypes.js";
import { fetchWithLimits } from "../../core/http/fetchWithLimits.js";
import { usageTotal } from "./openaiResponses.js";

const DEFAULT_BASE = "https://openrouter.ai/api/v1";

export type OpenRouterRequestOptions = {
  signal?: AbortSignal;
  temperature?: number;
  timeoutMs?: number;
  maxTokens?: number;
  // 未指定ならモデル既定。true/false は OpenRouter 共通の reasoning.enabled に変換する。
  thinking?: boolean;
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
  const sanitize = options.sanitizeOutput !== false;
  const maxResponseBytes = config.AI_MAX_RESPONSE_BYTES;

  const startedTotal = Date.now();
  // リトライはしない。1リクエストごとに予算予約を確定させるため、失敗時の再試行は
  // 呼び出し側（AiProviderRouter の DeepSeek 退避）に任せる。
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
        ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
        ...(options.thinking === undefined ? {} : { reasoning: { enabled: options.thinking } }),
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
  // 不正な値（小数・負数）だと予算の settle が失敗するため、OpenAI と同じ検証を通す。
  const usageTotalTokens = usageTotal(body);
  if (!raw) {
    throw new AiRequestError("invalid_response", "OpenRouter returned an empty response.", {
      usageTotalTokens,
    });
  }
  const content = sanitize ? sanitizeAiText(raw) : raw;
  const responseModel = typeof body.model === "string" && body.model.trim()
    ? body.model.trim()
    : model;
  return {
    content,
    ms: Date.now() - startedTotal,
    model: responseModel,
    ...(usageTotalTokens === undefined ? {} : { usageTotalTokens }),
  };
}

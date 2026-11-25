import type { AppConfig } from "../../core/config.js";
import { fetchWithLimits } from "../../core/http/fetchWithLimits.js";
import { sanitizeAiText, type ChatMessage } from "./chatTypes.js";

export type LocalLlmResult = {
  content: string;
  ms: number;
  model: string;
};

export type LocalLlmRequestOptions = {
  signal?: AbortSignal;
  temperature?: number;
  model?: string;
  sanitizeOutput?: boolean;
};

export async function localLlmChat(
  config: AppConfig,
  messages: ChatMessage[],
  options: LocalLlmRequestOptions = {},
): Promise<LocalLlmResult> {
  const rawBase = config.LOCAL_LLM_API_BASE?.trim();
  if (!rawBase) {
    throw new Error("LOCAL_LLM_API_BASE is not set. Set it in .env to use local LLM features.");
  }

  const apiKey = config.LOCAL_LLM_API_KEY.trim();
  if (!apiKey) {
    throw new Error("LOCAL_LLM_API_KEY is not set. Set it in .env to use local LLM features.");
  }

  const base = rawBase.replace(/\/+$/, "");
  const url = `${base}/chat/completions`;
  const model = options.model ?? config.LOCAL_LLM_MODEL;
  const temperature = options.temperature ?? config.LOCAL_LLM_TEMPERATURE;
  const sanitize = options.sanitizeOutput !== false;
  const started = Date.now();

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
      timeoutMs: config.LOCAL_LLM_TIMEOUT_MS,
      maxResponseBytes: config.AI_MAX_RESPONSE_BYTES,
      outerSignal: options.signal,
    },
  );

  if (!res.ok) {
    await res.text();
    throw new Error(`Local LLM HTTP ${res.status}`);
  }

  let body: {
    model?: unknown;
    choices?: Array<{ message?: { content?: string } }>;
  };
  try {
    body = await res.json() as typeof body;
  } catch {
    throw new Error("Local LLM returned invalid JSON");
  }
  const raw = body.choices?.[0]?.message?.content?.trim() ?? "";
  const responseModel = typeof body.model === "string" && body.model.trim()
    ? body.model.trim()
    : model;
  return {
    content: sanitize ? sanitizeAiText(raw) : raw,
    ms: Date.now() - started,
    model: responseModel,
  };
}

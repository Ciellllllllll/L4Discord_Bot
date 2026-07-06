import type { AppConfig } from "../../core/config.js";
import { fetchWithLimits } from "./fetchWithLimits.js";
import type { ChatMessage } from "./deepseek.js";

export type LocalLlmResult = {
  content: string;
  ms: number;
};

export type LocalLlmRequestOptions = {
  signal?: AbortSignal;
  temperature?: number;
  model?: string;
  sanitizeOutput?: boolean;
};

function sanitizeAiText(text: string): string {
  return String(text || "")
    .trim()
    .replace(/@everyone/g, "@\u200beveryone")
    .replace(/@here/g, "@\u200bhere")
    .replace(/<@(?:!?|&)\d+>/g, (match) => match.replace("<@", "<@\u200b"));
}

function safeErrorText(text: string, apiKey: string, rawBase: string): string {
  const base = rawBase.trim().replace(/\/+$/, "");
  const secrets = new Set<string>([apiKey, rawBase.trim(), base].filter(Boolean));
  try {
    const parsed = new URL(base);
    secrets.add(parsed.host);
    secrets.add(parsed.hostname);
  } catch {}

  let safe = String(text || "")
    .replaceAll(apiKey, "[redacted]")
    .replace(/Authorization\s*:\s*Bearer\s+\S+/gi, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "[redacted]");
  for (const secret of secrets) {
    safe = safe.replaceAll(secret, "[redacted]");
  }
  return safe;
}

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
    const text = await res.text();
    throw new Error(`Local LLM HTTP ${res.status}: ${safeErrorText(text, apiKey, rawBase).slice(0, 200)}`);
  }

  const body = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = body.choices?.[0]?.message?.content?.trim() ?? "";
  return {
    content: sanitize ? sanitizeAiText(raw) : raw,
    ms: Date.now() - started,
  };
}

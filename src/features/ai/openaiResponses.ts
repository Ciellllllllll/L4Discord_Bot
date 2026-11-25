import { AiRequestError } from "./aiRequestError.js";
import { type ChatMessage, sanitizeAiText } from "./chatTypes.js";
import { fetchWithLimits, type FetchWithLimitsOptions } from "../../core/http/fetchWithLimits.js";

export type OpenAiReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";

export type OpenAiResponsesConfig = {
  apiKey: string;
  apiBase: string;
  model: string;
  reasoningEffort: OpenAiReasoningEffort;
  timeoutMs: number;
  maxResponseBytes: number;
};

export type OpenAiResponsesOptions = {
  signal?: AbortSignal;
  thinking: boolean;
  maxOutputTokens: number;
  sanitizeOutput?: boolean;
  timeoutMs?: number;
};

export type OpenAiResponsesResult = {
  content: string;
  ms: number;
  model: string;
  usageTotalTokens: number;
};

type LimitedFetcher = (
  url: string,
  init: RequestInit,
  options: FetchWithLimitsOptions,
) => Promise<Response>;

export type OpenAiResponsesDeps = {
  fetcher?: LimitedFetcher;
};

function responseText(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  if (typeof record.output_text === "string") return record.output_text.trim();
  if (!Array.isArray(record.output)) return "";
  const parts: string[] = [];
  for (const item of record.output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const entry of content) {
      if (!entry || typeof entry !== "object") continue;
      const value = entry as Record<string, unknown>;
      if (value.type === "output_text" && typeof value.text === "string") {
        parts.push(value.text);
      }
    }
  }
  return parts.join("\n").trim();
}

export function usageTotal(body: unknown): number | undefined {
  if (!body || typeof body !== "object") return undefined;
  const usage = (body as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") return undefined;
  const value = (usage as Record<string, unknown>).total_tokens;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined;
}

function responseModel(body: unknown, requestedModel: string): string {
  if (!body || typeof body !== "object") return requestedModel;
  const value = (body as Record<string, unknown>).model;
  return typeof value === "string" && value.trim() ? value.trim() : requestedModel;
}

function apiErrorCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const error = (body as Record<string, unknown>).error;
  if (!error || typeof error !== "object") return undefined;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" && code ? code : undefined;
}

function buildInput(messages: ChatMessage[]): {
  instructions?: string;
  input: Array<{ role: "user" | "assistant"; content: string }>;
} {
  const systems = messages.filter((message) => message.role === "system").map((message) => message.content);
  const input = messages
    .filter((message): message is ChatMessage & { role: "user" | "assistant" } => message.role !== "system")
    .map((message) => ({ role: message.role, content: message.content }));
  return {
    ...(systems.length > 0 ? { instructions: systems.join("\n\n") } : {}),
    input,
  };
}

export async function openAiResponsesChat(
  config: OpenAiResponsesConfig,
  messages: ChatMessage[],
  options: OpenAiResponsesOptions,
  deps: OpenAiResponsesDeps = {},
): Promise<OpenAiResponsesResult> {
  const apiKey = config.apiKey.trim();
  if (!apiKey) {
    throw new AiRequestError("configuration", "OPENAI_API_KEY is not configured.");
  }
  const fetcher = deps.fetcher ?? fetchWithLimits;
  const url = `${config.apiBase.trim().replace(/\/+$/, "")}/responses`;
  const started = Date.now();

  let response: Response;
  try {
    response = await fetcher(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: config.model,
          ...buildInput(messages),
          reasoning: { effort: options.thinking ? config.reasoningEffort : "none" },
          max_output_tokens: options.maxOutputTokens,
        }),
      },
      {
        timeoutMs: options.timeoutMs ?? config.timeoutMs,
        maxResponseBytes: config.maxResponseBytes,
        outerSignal: options.signal,
      },
    );
  } catch (error) {
    if (error instanceof AiRequestError) throw error;
    if (options.signal?.aborted) {
      throw new AiRequestError("caller_abort", "OpenAI request was cancelled by the caller.", { cause: error });
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new AiRequestError("timeout", "OpenAI request timed out.", { cause: error });
    }
    throw new AiRequestError("network", "OpenAI request failed before a response was received.", { cause: error });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (!response.ok) {
      throw new AiRequestError("http_status", `OpenAI HTTP ${response.status}.`, {
        status: response.status,
      });
    }
    throw new AiRequestError("invalid_response", "OpenAI returned invalid JSON.");
  }
  const usageTotalTokens = usageTotal(body);
  if (!response.ok) {
    throw new AiRequestError("http_status", `OpenAI HTTP ${response.status}.`, {
      status: response.status,
      apiCode: apiErrorCode(body),
      usageTotalTokens,
    });
  }
  const raw = responseText(body);
  if (!raw || usageTotalTokens === undefined) {
    throw new AiRequestError("invalid_response", "OpenAI response did not contain text and usage.", {
      usageTotalTokens,
    });
  }
  return {
    content: options.sanitizeOutput === false ? raw : sanitizeAiText(raw),
    ms: Date.now() - started,
    model: responseModel(body, config.model),
    usageTotalTokens,
  };
}

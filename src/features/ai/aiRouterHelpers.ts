import type { ChatMessage } from "./chatTypes.js";
import type { AiRequestError } from "./aiRequestError.js";
import type { AppConfig } from "../../core/config.js";
import type { AiFallbackReason, AiTask } from "./aiRouterTypes.js";

// AI ルーターのタスク共通の純関数群。

export function nextUtcMidnight(usageDate?: string): string {
  const date = usageDate ?? new Date().toISOString().slice(0, 10);
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + 86_400_000).toISOString();
}

export function currentUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function reservationEstimate(messages: ChatMessage[], maxOutputTokens: number): number {
  const inputBytes = Buffer.byteLength(JSON.stringify(messages), "utf8");
  return Math.max(1, inputBytes + 1_024 + maxOutputTokens);
}

export function deepSeekModel(config: Pick<AppConfig, "DEEPSEEK_MODEL" | "SENRYU_AI_REVIEW_MODEL">, task: AiTask): string | undefined {
  if (task === "prompt_generator") return "deepseek-v4-pro";
  if (task === "senryu_review") return config.SENRYU_AI_REVIEW_MODEL ?? config.DEEPSEEK_MODEL;
  return undefined;
}

export function fallbackForOpenAiError(error: AiRequestError): AiFallbackReason | undefined {
  if (error.kind === "network") return "openai_network";
  if (error.kind === "timeout") return "openai_timeout";
  if (error.kind === "invalid_response") return "openai_invalid_response";
  if (error.kind === "configuration") return "openai_unconfigured";
  if (error.kind !== "http_status") return undefined;
  if (error.apiCode && new Set([
    "model_not_found",
    "model_not_available",
    "unsupported_model",
    "permission_denied",
  ]).has(error.apiCode)) return "openai_model_unavailable";
  if (error.status === 401 || error.status === 403) return "openai_unauthorized";
  if (error.status === 404) return "openai_model_unavailable";
  if (error.status === 408) return "openai_408";
  if (error.status === 429) return "openai_429";
  if (error.status !== undefined && error.status >= 500) return "openai_server_error";
  return undefined;
}

export function releaseOnFailure(error: AiRequestError): boolean {
  if (error.kind === "configuration") return true;
  if (error.kind !== "http_status" || error.status === undefined) return false;
  return error.status >= 400 && error.status < 500 && error.status !== 408;
}

export function shouldTryMiniAfterTerra(reason: AiFallbackReason): boolean {
  return reason === "openai_model_unavailable" || reason === "openai_unauthorized";
}

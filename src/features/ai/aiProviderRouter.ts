import { randomUUID } from "node:crypto";
import type { AppConfig } from "../../core/config.js";
import type {
  AiProviderBudgetRepository,
  AiProviderSettingsRepository,
} from "./aiProviderRepository.js";
import { AiRequestError } from "./aiRequestError.js";
import type { ChatMessage } from "./chatTypes.js";
import { deepseekChat, type DeepSeekRequestOptions, type DeepSeekResult } from "./deepseek.js";
import { openAiResponsesChat, type OpenAiResponsesOptions, type OpenAiResponsesResult } from "./openaiResponses.js";
import { OpenAiUsageClient, type OpenAiUsageSnapshot } from "./openaiUsage.js";
import type { AiProvider, AiRoutePreference, OpenAiModelPreference } from "./providerTypes.js";

export type AiTask =
  | "answer"
  | "judge"
  | "prompt_optimizer"
  | "prompt_generator"
  | "senryu_review"
  | "pacchi_final_check"
  | "vx_translation"
  | "ping";

export type AiFallbackReason =
  | "manual_deepseek"
  | "openai_unconfigured"
  | "usage_unavailable"
  | "budget_threshold"
  | "openai_unauthorized"
  | "openai_model_unavailable"
  | "openai_408"
  | "openai_429"
  | "openai_server_error"
  | "openai_network"
  | "openai_timeout"
  | "openai_invalid_response"
  | "openai_model_fallback";

export type AiChatResult = {
  content: string;
  ms: number;
  model: string;
  provider: AiProvider;
  usageTotalTokens?: number;
  fallbackReason?: AiFallbackReason;
};

export type AiRouterStatus = {
  preferredProvider: AiProvider;
  preferredOpenAiModel: OpenAiModelPreference;
  effectiveProvider: AiProvider;
  effectiveModel?: string;
  fallbackReason?: AiFallbackReason;
  effectiveTokens?: number;
  resetAtUtc: string;
};

export type AiRouterChatOptions = {
  signal?: AbortSignal;
  thinking: boolean;
  sanitizeOutput?: boolean;
  temperature?: number;
  timeoutMs?: number;
  maxRetries?: number;
};

type RouterConfig = Pick<AppConfig,
  | "OPENAI_API_KEY"
  | "OPENAI_ADMIN_KEY"
  | "OPENAI_PROJECT_ID"
  | "OPENAI_API_BASE"
  | "OPENAI_MODEL_GPT56"
  | "OPENAI_MODEL_GPT54_MINI"
  | "OPENAI_REASONING_EFFORT"
  | "OPENAI_FALLBACK_THRESHOLD"
  | "OPENAI_USAGE_CACHE_MS"
  | "OPENAI_MAX_COMPLETION_TOKENS"
  | "AI_REQUEST_TIMEOUT_MS"
  | "AI_MAX_RESPONSE_BYTES"
  | "DEEPSEEK_MODEL"
  | "SENRYU_AI_REVIEW_MODEL"
>;

type UsageReader = { getTodaySnapshot(): Promise<OpenAiUsageSnapshot> };

export type AiProviderRouterDeps = {
  usageClient?: UsageReader;
  openAiChat?: (
    messages: ChatMessage[],
    options: OpenAiResponsesOptions,
    model: string,
  ) => Promise<OpenAiResponsesResult>;
  deepSeekChat?: (messages: ChatMessage[], options: DeepSeekRequestOptions) => Promise<DeepSeekResult>;
  reservationId?: () => string;
};

const TASK_MAX_OUTPUT: Record<AiTask, number> = {
  answer: 8_192,
  prompt_generator: 4_096,
  prompt_optimizer: 2_048,
  judge: 512,
  senryu_review: 512,
  pacchi_final_check: 512,
  vx_translation: 512,
  ping: 1_024,
};

function nextUtcMidnight(usageDate?: string): string {
  const date = usageDate ?? new Date().toISOString().slice(0, 10);
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + 86_400_000).toISOString();
}

function reservationEstimate(messages: ChatMessage[], maxOutputTokens: number): number {
  const inputBytes = Buffer.byteLength(JSON.stringify(messages), "utf8");
  return Math.max(1, inputBytes + 1_024 + maxOutputTokens);
}

function deepSeekModel(config: RouterConfig, task: AiTask): string | undefined {
  if (task === "prompt_generator") return "deepseek-v4-pro";
  if (task === "senryu_review") return config.SENRYU_AI_REVIEW_MODEL ?? config.DEEPSEEK_MODEL;
  return undefined;
}

function fallbackForOpenAiError(error: AiRequestError): AiFallbackReason | undefined {
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

function releaseOnFailure(error: AiRequestError): boolean {
  if (error.kind === "configuration") return true;
  if (error.kind !== "http_status" || error.status === undefined) return false;
  return error.status >= 400 && error.status < 500 && error.status !== 408;
}

function shouldTryMiniAfterTerra(reason: AiFallbackReason): boolean {
  return reason === "openai_model_unavailable" || reason === "openai_unauthorized";
}

type OpenAiAttemptOutcome =
  | { ok: true; result: AiChatResult }
  | { ok: false; reason: AiFallbackReason };

export class AiProviderRouter {
  private readonly usageClient: UsageReader;
  private readonly openAiChat: AiProviderRouterDeps["openAiChat"];
  private readonly deepSeekChat: NonNullable<AiProviderRouterDeps["deepSeekChat"]>;
  private readonly reservationId: () => string;

  constructor(
    private readonly config: RouterConfig,
    private readonly settings: AiProviderSettingsRepository,
    private readonly budget: AiProviderBudgetRepository,
    deps: AiProviderRouterDeps = {},
  ) {
    this.usageClient = deps.usageClient ?? new OpenAiUsageClient({
      adminKey: config.OPENAI_ADMIN_KEY,
      apiBase: config.OPENAI_API_BASE,
      projectId: config.OPENAI_PROJECT_ID,
      cacheMs: config.OPENAI_USAGE_CACHE_MS,
      timeoutMs: config.AI_REQUEST_TIMEOUT_MS,
      maxResponseBytes: config.AI_MAX_RESPONSE_BYTES,
    });
    this.openAiChat = deps.openAiChat ?? ((messages, options, model) => openAiResponsesChat({
      apiKey: config.OPENAI_API_KEY,
      apiBase: config.OPENAI_API_BASE,
      model,
      reasoningEffort: config.OPENAI_REASONING_EFFORT,
      timeoutMs: config.AI_REQUEST_TIMEOUT_MS,
      maxResponseBytes: config.AI_MAX_RESPONSE_BYTES,
    }, messages, options));
    this.deepSeekChat = deps.deepSeekChat ?? ((messages, options) => deepseekChat(config as AppConfig, messages, options));
    this.reservationId = deps.reservationId ?? randomUUID;
  }

  async setPreference(guildId: string, preference: AiRoutePreference): Promise<void> {
    await this.settings.setPreference(guildId, preference);
  }

  async getPreference(guildId: string): Promise<AiRoutePreference> {
    return this.settings.getPreference(guildId);
  }

  async getStatus(guildId: string): Promise<AiRouterStatus> {
    const preference = await this.settings.getPreference(guildId);
    const preferredProvider = preference.provider;
    if (preferredProvider === "deepseek") {
      return {
        preferredProvider,
        preferredOpenAiModel: preference.openAiModel,
        effectiveProvider: "deepseek",
        fallbackReason: "manual_deepseek",
        resetAtUtc: nextUtcMidnight(),
      };
    }
    if (!this.config.OPENAI_API_KEY.trim()) {
      return {
        preferredProvider,
        preferredOpenAiModel: preference.openAiModel,
        effectiveProvider: "deepseek",
        fallbackReason: "openai_unconfigured",
        resetAtUtc: nextUtcMidnight(),
      };
    }
    let snapshot: OpenAiUsageSnapshot;
    try {
      snapshot = await this.usageClient.getTodaySnapshot();
    } catch {
      return {
        preferredProvider,
        preferredOpenAiModel: preference.openAiModel,
        effectiveProvider: "deepseek",
        fallbackReason: "usage_unavailable",
        resetAtUtc: nextUtcMidnight(),
      };
    }
    const reservationId = this.reservationId();
    const result = await this.budget.tryReserve({
      reservationId,
      provider: "openai",
      usageDate: snapshot.usageDate,
      reservedTokens: 0,
      threshold: this.config.OPENAI_FALLBACK_THRESHOLD,
      snapshot: { orgTargetTokens: snapshot.organizationTokens, botReportedTokens: snapshot.botProjectTokens },
    });
    if (result.allowed) await this.budget.release(reservationId);
    return {
      preferredProvider,
      preferredOpenAiModel: preference.openAiModel,
      effectiveProvider: result.allowed ? "openai" : "deepseek",
      ...(result.allowed ? { effectiveModel: this.modelFor(preference.openAiModel) } : {}),
      ...(result.allowed ? {} : { fallbackReason: "budget_threshold" as const }),
      effectiveTokens: result.effectiveTokens,
      resetAtUtc: nextUtcMidnight(snapshot.usageDate),
    };
  }

  async chat(
    guildId: string,
    task: AiTask,
    messages: ChatMessage[],
    options: AiRouterChatOptions,
  ): Promise<AiChatResult> {
    if (options.signal?.aborted) {
      throw new AiRequestError("caller_abort", "AI request was cancelled before dispatch.");
    }
    const preference = await this.settings.getPreference(guildId);
    if (preference.provider === "deepseek") {
      return this.callDeepSeek(task, messages, options, "manual_deepseek");
    }
    if (!this.config.OPENAI_API_KEY.trim()) {
      return this.callDeepSeek(task, messages, options, "openai_unconfigured");
    }

    let snapshot: OpenAiUsageSnapshot;
    try {
      snapshot = await this.usageClient.getTodaySnapshot();
    } catch {
      return this.callDeepSeek(task, messages, options, "usage_unavailable");
    }

    const maxOutputTokens = task === "answer"
      ? this.config.OPENAI_MAX_COMPLETION_TOKENS
      : TASK_MAX_OUTPUT[task];
    const primaryModel = this.modelFor(preference.openAiModel);
    const primary = await this.attemptOpenAi(messages, options, maxOutputTokens, snapshot, primaryModel);
    if (primary.ok) return primary.result;

    if (preference.openAiModel === "gpt56" && shouldTryMiniAfterTerra(primary.reason)) {
      const mini = await this.attemptOpenAi(
        messages,
        options,
        maxOutputTokens,
        snapshot,
        this.config.OPENAI_MODEL_GPT54_MINI,
      );
      if (mini.ok) {
        return { ...mini.result, fallbackReason: "openai_model_fallback" };
      }
      return this.callDeepSeek(task, messages, options, mini.reason);
    }
    return this.callDeepSeek(task, messages, options, primary.reason);
  }

  private modelFor(preference: OpenAiModelPreference): string {
    return preference === "gpt56"
      ? this.config.OPENAI_MODEL_GPT56
      : this.config.OPENAI_MODEL_GPT54_MINI;
  }

  private async attemptOpenAi(
    messages: ChatMessage[],
    options: AiRouterChatOptions,
    maxOutputTokens: number,
    snapshot: OpenAiUsageSnapshot,
    model: string,
  ): Promise<OpenAiAttemptOutcome> {
    const reservationId = this.reservationId();
    const reservedTokens = reservationEstimate(messages, maxOutputTokens);
    const reservation = await this.budget.tryReserve({
      reservationId,
      provider: "openai",
      usageDate: snapshot.usageDate,
      reservedTokens,
      threshold: this.config.OPENAI_FALLBACK_THRESHOLD,
      snapshot: { orgTargetTokens: snapshot.organizationTokens, botReportedTokens: snapshot.botProjectTokens },
    });
    if (!reservation.allowed) return { ok: false, reason: "budget_threshold" };

    let result: OpenAiResponsesResult;
    try {
      result = await this.openAiChat!(messages, {
        signal: options.signal,
        thinking: options.thinking,
        maxOutputTokens,
        sanitizeOutput: options.sanitizeOutput,
        timeoutMs: options.timeoutMs,
      }, model);
    } catch (error) {
      const typed = error instanceof AiRequestError
        ? error
        : new AiRequestError("invalid_response", "OpenAI adapter returned an unexpected error.", { cause: error });
      if (typed.usageTotalTokens !== undefined) {
        await this.budget.settle(reservationId, typed.usageTotalTokens);
      } else if (releaseOnFailure(typed)) {
        await this.budget.release(reservationId);
      } else {
        await this.budget.consumeEstimate(reservationId);
      }
      if (typed.kind === "caller_abort") throw typed;
      const fallbackReason = fallbackForOpenAiError(typed);
      if (!fallbackReason) throw typed;
      return { ok: false, reason: fallbackReason };
    }
    await this.budget.settle(reservationId, result.usageTotalTokens);
    return {
      ok: true,
      result: { ...result, provider: "openai", usageTotalTokens: result.usageTotalTokens },
    };
  }

  private async callDeepSeek(
    task: AiTask,
    messages: ChatMessage[],
    options: AiRouterChatOptions,
    fallbackReason: AiFallbackReason,
  ): Promise<AiChatResult> {
    const result = await this.deepSeekChat(messages, {
      signal: options.signal,
      thinking: options.thinking,
      sanitizeOutput: options.sanitizeOutput,
      temperature: options.temperature,
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
      model: deepSeekModel(this.config, task),
    });
    return { ...result, provider: "deepseek", fallbackReason };
  }
}

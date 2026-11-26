import { randomUUID } from "node:crypto";
import { currentUtcDate, deepSeekModel, fallbackForOpenAiError, nextUtcMidnight, releaseOnFailure, reservationEstimate, shouldTryMiniAfterTerra } from "./aiRouterHelpers.js";
import type { AiFallbackReason, AiTask } from "./aiRouterTypes.js";
import type { AppConfig } from "../../core/config.js";
import type {
  AiProviderBudgetRepository,
  AiProviderSettingsRepository,
} from "./aiProviderRepository.js";
import { AiRequestError } from "./aiRequestError.js";
import type { ChatMessage } from "./chatTypes.js";
import { deepseekChat, type DeepSeekMessage, type DeepSeekRequestOptions, type DeepSeekResult } from "./deepseek.js";
import { openAiResponsesChat, type OpenAiResponsesOptions, type OpenAiResponsesResult } from "./openaiResponses.js";
import { OpenAiUsageClient, type OpenAiUsageSnapshot } from "./openaiUsage.js";
import { openRouterChat, type OpenRouterRequestOptions, type OpenRouterResult } from "./openrouter.js";
import type { AiProvider, AiRoutePreference, OpenAiModelPreference } from "./providerTypes.js";

export type { AiFallbackReason, AiTask } from "./aiRouterTypes.js";

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
  imageDataUrl?: string;
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
  | "OPENROUTER_API_KEY"
  | "OPENROUTER_API_BASE"
  | "OPENROUTER_MODEL"
  | "OPENROUTER_DAILY_TOKEN_LIMIT"
  | "AI_TEMPERATURE"
  | "AI_MAX_RETRIES"
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
  deepSeekChat?: (messages: DeepSeekMessage[], options: DeepSeekRequestOptions) => Promise<DeepSeekResult>;
  openRouterChat?: (messages: ChatMessage[], options: OpenRouterRequestOptions) => Promise<OpenRouterResult>;
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
  preview_translation: 4_096,
  preview_summary: 2_048,
  ping: 1_024,
};


type OpenAiAttemptOutcome =
  | { ok: true; result: AiChatResult }
  | { ok: false; reason: AiFallbackReason };

export class AiProviderRouter {
  private readonly usageClient: UsageReader;
  private readonly openAiChat: AiProviderRouterDeps["openAiChat"];
  private readonly deepSeekChat: NonNullable<AiProviderRouterDeps["deepSeekChat"]>;
  private readonly openRouterChat: NonNullable<AiProviderRouterDeps["openRouterChat"]>;
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
    this.openRouterChat = deps.openRouterChat ?? ((messages, options) => openRouterChat(config as AppConfig, messages, options));
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
    if (preferredProvider === "openrouter") {
      if (!this.config.OPENROUTER_API_KEY.trim()) {
        return {
          preferredProvider,
          preferredOpenAiModel: preference.openAiModel,
          effectiveProvider: "deepseek",
          fallbackReason: "openrouter_unconfigured",
          resetAtUtc: nextUtcMidnight(),
        };
      }
      let budgetAllowed: boolean;
      let effectiveTokens: number | undefined;
      try {
        const reservationId = this.reservationId();
        const result = await this.budget.tryReserve({
          reservationId,
          provider: "openrouter",
          usageDate: currentUtcDate(),
          reservedTokens: 0,
          threshold: this.config.OPENROUTER_DAILY_TOKEN_LIMIT,
          snapshot: { orgTargetTokens: 0, botReportedTokens: 0 },
        });
        budgetAllowed = result.allowed;
        effectiveTokens = result.effectiveTokens;
        if (result.allowed) await this.budget.release(reservationId);
      } catch {
        return {
          preferredProvider,
          preferredOpenAiModel: preference.openAiModel,
          effectiveProvider: "deepseek",
          fallbackReason: "usage_unavailable",
          resetAtUtc: nextUtcMidnight(),
        };
      }
      return {
        preferredProvider,
        preferredOpenAiModel: preference.openAiModel,
        effectiveProvider: budgetAllowed ? "openrouter" : "deepseek",
        ...(budgetAllowed
          ? { effectiveModel: this.config.OPENROUTER_MODEL }
          : { fallbackReason: "openrouter_budget_threshold" as const }),
        effectiveTokens,
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
    if (options.imageDataUrl) {
      if (task !== "answer") throw new AiRequestError("configuration", "Images are only supported for answers.");
      return this.callDeepSeek(task, messages, options, "task_policy_deepseek");
    }
    if (task === "prompt_generator") {
      return this.callDeepSeek(task, messages, options, "task_policy_deepseek");
    }
    const preference = await this.settings.getPreference(guildId);
    if (preference.provider === "deepseek") {
      return this.callDeepSeek(task, messages, options, "manual_deepseek");
    }
    if (preference.provider === "openrouter") {
      // OpenRouter は /q（answer）だけに使い、それ以外のタスクは DeepSeek に固定する。
      if (task !== "answer") return this.callDeepSeek(task, messages, options, "task_policy_deepseek");
      if (!this.config.OPENROUTER_API_KEY.trim()) {
        throw new AiRequestError(
          "configuration",
          "OPENROUTER_API_KEY is not configured. Set it in .env or switch the provider with /switch.",
        );
      }
      const maxOutputTokens = TASK_MAX_OUTPUT[task];
      const attempt = await this.attemptOpenRouter(messages, options, maxOutputTokens);
      if (attempt.ok) return attempt.result;
      return this.callDeepSeek(task, messages, options, attempt.reason);
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

  private async settleFailedReservation(reservationId: string, typed: AiRequestError): Promise<void> {
    if (typed.usageTotalTokens !== undefined) {
      await this.budget.settle(reservationId, typed.usageTotalTokens);
    } else if (releaseOnFailure(typed)) {
      await this.budget.release(reservationId);
    } else {
      await this.budget.consumeEstimate(reservationId);
    }
  }

  private async attemptOpenRouter(
    messages: ChatMessage[],
    options: AiRouterChatOptions,
    maxOutputTokens: number,
  ): Promise<OpenAiAttemptOutcome> {
    const reservationId = this.reservationId();
    const reservedTokens = reservationEstimate(messages, maxOutputTokens);
    const reservation = await this.budget.tryReserve({
      reservationId,
      provider: "openrouter",
      usageDate: currentUtcDate(),
      reservedTokens,
      threshold: this.config.OPENROUTER_DAILY_TOKEN_LIMIT,
      snapshot: { orgTargetTokens: 0, botReportedTokens: 0 },
    });
    if (!reservation.allowed) return { ok: false, reason: "openrouter_budget_threshold" };

    let result: OpenRouterResult;
    try {
      result = await this.openRouterChat(messages, {
        signal: options.signal,
        thinking: options.thinking,
        temperature: options.temperature,
        timeoutMs: options.timeoutMs,
        maxTokens: maxOutputTokens,
        sanitizeOutput: options.sanitizeOutput,
      });
    } catch (error) {
      const typed = error instanceof AiRequestError
        ? error
        : new AiRequestError("invalid_response", "OpenRouter adapter returned an unexpected error.", { cause: error });
      await this.settleFailedReservation(reservationId, typed);
      if (typed.kind === "caller_abort" || typed.kind === "configuration") throw typed;
      return { ok: false, reason: "openrouter_failed" };
    }

    // usage が返らない場合は予約見積もりを実使用として確定し、上限超過を防ぐ。
    await this.budget.settle(reservationId, result.usageTotalTokens ?? reservedTokens);
    return {
      ok: true,
      result: {
        ...result,
        provider: "openrouter",
        usageTotalTokens: result.usageTotalTokens ?? reservedTokens,
      },
    };
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
      await this.settleFailedReservation(reservationId, typed);
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
    let input: DeepSeekMessage[] = messages;
    if (options.imageDataUrl) {
      const last = messages.at(-1);
      if (last?.role !== "user") throw new AiRequestError("configuration", "Image input requires a final user message.");
      input = [...messages.slice(0, -1), { role: "user", content: [
        { type: "text", text: last.content },
        { type: "image_url", image_url: { url: options.imageDataUrl } },
      ] }];
    }
    const result = await this.deepSeekChat(input, {
      signal: options.signal,
      thinking: options.thinking,
      sanitizeOutput: options.sanitizeOutput,
      temperature: options.temperature,
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
      model: options.imageDataUrl ? "deepseek-flash" : deepSeekModel(this.config, task),
    });
    if (!result.content.trim()) {
      throw new AiRequestError("invalid_response", "DeepSeek returned an empty response.");
    }
    return { ...result, provider: "deepseek", fallbackReason };
  }
}

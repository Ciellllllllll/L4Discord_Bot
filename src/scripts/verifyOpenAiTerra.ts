import "dotenv/config";
import { loadConfig } from "../core/config.js";
import { AiRequestError } from "../features/ai/aiRequestError.js";
import { openAiResponsesChat } from "../features/ai/openaiResponses.js";
import { OpenAiUsageClient } from "../features/ai/openaiUsage.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.OPENAI_API_KEY.trim() || !config.OPENAI_ADMIN_KEY.trim() || !config.OPENAI_PROJECT_ID.trim()) {
    throw new Error("OPENAI_API_KEY, OPENAI_ADMIN_KEY, OPENAI_PROJECT_ID must be configured.");
  }

  const models = [
    { route: "gpt56", model: config.OPENAI_MODEL_GPT56 },
    { route: "gpt54_mini", model: config.OPENAI_MODEL_GPT54_MINI },
  ] as const;
  const messages = [
    { role: "system" as const, content: "Reply with a short acknowledgement." },
    { role: "user" as const, content: "Connectivity verification." },
  ];
  const usageClient = new OpenAiUsageClient({
    adminKey: config.OPENAI_ADMIN_KEY,
    apiBase: config.OPENAI_API_BASE,
    projectId: config.OPENAI_PROJECT_ID,
    cacheMs: 0,
    timeoutMs: config.AI_REQUEST_TIMEOUT_MS,
    maxResponseBytes: config.AI_MAX_RESPONSE_BYTES,
  });
  const beforeUsage = await usageClient.getTodaySnapshot();
  const verificationReserve = models.length * 2 * (2_048 + 128);
  const forced = process.argv.includes("--force");
  if (!forced && beforeUsage.organizationTokens + verificationReserve > config.OPENAI_FALLBACK_THRESHOLD) {
    throw new Error("OpenAI Terra verification refused near the daily safety threshold. Use --force only after manual review.");
  }
  const results = [];
  for (const target of models) {
    const responsesConfig = {
      apiKey: config.OPENAI_API_KEY,
      apiBase: config.OPENAI_API_BASE,
      model: target.model,
      reasoningEffort: config.OPENAI_REASONING_EFFORT,
      timeoutMs: config.AI_REQUEST_TIMEOUT_MS,
      maxResponseBytes: config.AI_MAX_RESPONSE_BYTES,
    };
    try {
      const none = await openAiResponsesChat(responsesConfig, messages, {
        thinking: false,
        maxOutputTokens: 64,
        sanitizeOutput: false,
      });
      const configured = await openAiResponsesChat(responsesConfig, messages, {
        thinking: true,
        maxOutputTokens: Math.min(config.OPENAI_MAX_COMPLETION_TOKENS, 128),
        sanitizeOutput: false,
      });
      results.push({
        route: target.route,
        configuredModel: target.model,
        available: true,
        returnedModels: [none.model, configured.model],
        none: { textPresent: none.content.length > 0, usageTotalTokens: none.usageTotalTokens },
        configuredReasoning: { textPresent: configured.content.length > 0, usageTotalTokens: configured.usageTotalTokens },
      });
    } catch (error) {
      const typed = error instanceof AiRequestError ? error : null;
      results.push({
        route: target.route,
        configuredModel: target.model,
        available: false,
        errorKind: typed?.kind ?? "unknown",
        status: typed?.status,
        apiCode: typed?.apiCode,
      });
    }
  }
  const usage = await usageClient.getTodaySnapshot();

  console.log({
    models: results,
    usage: {
      usageDate: usage.usageDate,
      organizationTokens: usage.organizationTokens,
      botProjectTokens: usage.botProjectTokens,
      targetModelProjectObserved: usage.botProjectTokens > 0,
    },
    safetyCheck: { forced, estimatedReservationTokens: verificationReserve },
  });
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "OpenAI Terra verification failed.");
  process.exitCode = 1;
});

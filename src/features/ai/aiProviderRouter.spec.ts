import assert from "node:assert/strict";
import { AiProviderRouter } from "./aiProviderRouter.js";
import { AiRequestError } from "./aiRequestError.js";
import type {
  AiProviderBudgetRepository,
  AiProviderSettingsRepository,
  AiTokenReservation,
} from "./aiProviderRepository.js";
import type { AiRoutePreference } from "./providerTypes.js";

const baseConfig = {
  OPENAI_API_KEY: "openai",
  OPENAI_ADMIN_KEY: "admin",
  OPENAI_PROJECT_ID: "project",
  OPENAI_API_BASE: "https://api.openai.test/v1",
  OPENAI_MODEL_GPT56: "gpt-5.6-terra",
  OPENAI_MODEL_GPT54_MINI: "gpt-5.4-mini-2026-03-17",
  OPENAI_REASONING_EFFORT: "high" as const,
  OPENAI_FALLBACK_THRESHOLD: 2_400_000,
  OPENAI_USAGE_CACHE_MS: 30_000,
  OPENAI_MAX_COMPLETION_TOKENS: 8_192,
  AI_REQUEST_TIMEOUT_MS: 1_000,
  AI_MAX_RESPONSE_BYTES: 10_000,
  DEEPSEEK_MODEL: "deepseek-v4-flash",
  SENRYU_AI_REVIEW_MODEL: "senryu-legacy",
};

function repositories(
  preferred: AiRoutePreference = { provider: "openai", openAiModel: "gpt56" },
) {
  let selected = preferred;
  const calls: string[] = [];
  const settings: AiProviderSettingsRepository = {
    async getPreference() { return selected; },
    async setPreference(_guildId, preference) { selected = preference; },
  };
  const reservation: AiTokenReservation = {
    reservationId: "r1", provider: "openai", usageDate: "2026-07-10",
    reservedTokens: 100, status: "pending", actualTokens: null,
  };
  const budget: AiProviderBudgetRepository = {
    async tryReserve(input) {
      calls.push(`reserve:${input.reservedTokens}`);
      return { allowed: true, duplicate: false, effectiveTokens: input.reservedTokens, reservation: { ...reservation, reservationId: input.reservationId, reservedTokens: input.reservedTokens } };
    },
    async settle(_id, actual) { calls.push(`settle:${actual}`); return { ...reservation, status: "settled", actualTokens: actual }; },
    async consumeEstimate() { calls.push("consume"); return { ...reservation, status: "settled", actualTokens: 100 }; },
    async release() { calls.push("release"); return { ...reservation, status: "released" }; },
  };
  return { settings, budget, calls };
}

async function main() {
  {
    const repo = repositories();
    let openAiCalls = 0;
    const router = new AiProviderRouter(baseConfig, repo.settings, repo.budget, {
      usageClient: { async getTodaySnapshot() { return { usageDate: "2026-07-10", organizationTokens: 10, botProjectTokens: 4 }; } },
      async openAiChat(_messages, options, model) {
        openAiCalls += 1;
        assert.equal(options.maxOutputTokens, 512);
        assert.equal(model, "gpt-5.6-terra");
        return { content: "terra", ms: 3, model: "gpt-5.6-terra-response", usageTotalTokens: 42 };
      },
      async deepSeekChat() { throw new Error("unexpected"); },
      reservationId: () => "r1",
    });
    const result = await router.chat("guild", "judge", [{ role: "user", content: "hello" }], { thinking: false });
    assert.equal(result.provider, "openai");
    assert.equal(result.model, "gpt-5.6-terra-response");
    assert.equal(result.usageTotalTokens, 42);
    assert.equal(openAiCalls, 1);
    assert.deepEqual(repo.calls.slice(-1), ["settle:42"]);
  }

  {
    const repo = repositories({ provider: "openai", openAiModel: "gpt54_mini" });
    const models: string[] = [];
    const router = new AiProviderRouter(baseConfig, repo.settings, repo.budget, {
      usageClient: { async getTodaySnapshot() { return { usageDate: "2026-07-10", organizationTokens: 1, botProjectTokens: 1 }; } },
      async openAiChat(_messages, _options, model) {
        models.push(model);
        return { content: "mini", ms: 2, model: "gpt-5.4-mini-response", usageTotalTokens: 20 };
      },
      async deepSeekChat() { throw new Error("unexpected"); },
      reservationId: () => "mini-r1",
    });
    const result = await router.chat("guild", "answer", [{ role: "user", content: "hello" }], { thinking: false });
    assert.deepEqual(models, ["gpt-5.4-mini-2026-03-17"]);
    assert.equal(result.provider, "openai");
    assert.equal(result.model, "gpt-5.4-mini-response");
  }

  {
    const repo = repositories({ provider: "openai", openAiModel: "gpt54_mini" });
    let preferenceReads = 0;
    const originalGetPreference = repo.settings.getPreference;
    repo.settings.getPreference = async (guildId) => {
      preferenceReads += 1;
      return originalGetPreference(guildId);
    };
    let usageCalls = 0;
    let openAiCalls = 0;
    const deepSeekModels: Array<string | undefined> = [];
    const router = new AiProviderRouter(baseConfig, repo.settings, repo.budget, {
      usageClient: {
        async getTodaySnapshot() {
          usageCalls += 1;
          return { usageDate: "2026-07-10", organizationTokens: 1, botProjectTokens: 1 };
        },
      },
      async openAiChat() {
        openAiCalls += 1;
        return { content: "mini answer", ms: 2, model: "gpt-5.4-mini-response", usageTotalTokens: 20 };
      },
      async deepSeekChat(_messages, options) {
        deepSeekModels.push(options.model);
        return { content: "generated prompt", ms: 3, model: "deepseek-v4-pro-response" };
      },
      reservationId: () => "fixed-task-r1",
    });

    const generated = await router.chat(
      "guild",
      "prompt_generator",
      [{ role: "user", content: "generate" }],
      { thinking: true },
    );
    assert.equal(generated.provider, "deepseek");
    assert.equal(generated.fallbackReason, "task_policy_deepseek");
    assert.deepEqual(deepSeekModels, ["deepseek-v4-pro"]);
    assert.equal(preferenceReads, 0);
    assert.equal(usageCalls, 0);
    assert.equal(openAiCalls, 0);
    assert.deepEqual(repo.calls, []);

    const answer = await router.chat(
      "guild",
      "answer",
      [{ role: "user", content: "question" }],
      { thinking: false },
    );
    assert.equal(answer.provider, "openai");
    assert.equal(answer.model, "gpt-5.4-mini-response");
    assert.equal(preferenceReads, 1);
    assert.equal(usageCalls, 1);
    assert.equal(openAiCalls, 1);
  }

  {
    let settingsCalls = 0;
    let openAiCalls = 0;
    const repo = repositories({ provider: "openai", openAiModel: "gpt56" });
    repo.settings.getPreference = async () => {
      settingsCalls += 1;
      return { provider: "openai", openAiModel: "gpt56" };
    };
    const router = new AiProviderRouter(baseConfig, repo.settings, repo.budget, {
      usageClient: { async getTodaySnapshot() { throw new Error("usage must not be called"); } },
      async openAiChat() {
        openAiCalls += 1;
        throw new Error("OpenAI must not be called");
      },
      async deepSeekChat() { throw new Error("deepseek prompt failure"); },
    });
    await assert.rejects(
      router.chat("guild", "prompt_generator", [{ role: "user", content: "x" }], { thinking: true }),
      /deepseek prompt failure/,
    );
    assert.equal(settingsCalls, 0);
    assert.equal(openAiCalls, 0);
    assert.deepEqual(repo.calls, []);
  }

  {
    const repo = repositories({ provider: "deepseek", openAiModel: "gpt56" });
    let usageCalls = 0;
    const router = new AiProviderRouter(baseConfig, repo.settings, repo.budget, {
      usageClient: { async getTodaySnapshot() { usageCalls += 1; throw new Error("unexpected"); } },
      async openAiChat() { throw new Error("unexpected"); },
      async deepSeekChat(_messages, options) {
        assert.equal(options.model, "deepseek-v4-pro");
        return { content: "deepseek", ms: 2, model: "deepseek-v4-pro-response" };
      },
    });
    const result = await router.chat("guild", "prompt_generator", [{ role: "user", content: "x" }], { thinking: true });
    assert.equal(result.provider, "deepseek");
    assert.equal(result.model, "deepseek-v4-pro-response");
    assert.equal(result.fallbackReason, "task_policy_deepseek");
    assert.equal(usageCalls, 0);
  }

  {
    const repo = repositories();
    repo.budget.tryReserve = async () => ({ allowed: false, duplicate: false, effectiveTokens: 2_400_001, reason: "threshold_exceeded" });
    const router = new AiProviderRouter(baseConfig, repo.settings, repo.budget, {
      usageClient: { async getTodaySnapshot() { return { usageDate: "2026-07-10", organizationTokens: 2_399_000, botProjectTokens: 1_000 }; } },
      async openAiChat() { throw new Error("unexpected"); },
      async deepSeekChat() { return { content: "fallback", ms: 1, model: "deepseek-fallback" }; },
    });
    const result = await router.chat("guild", "answer", [{ role: "user", content: "x" }], { thinking: true });
    assert.equal(result.provider, "deepseek");
    assert.equal(result.model, "deepseek-fallback");
    assert.equal(result.fallbackReason, "budget_threshold");
  }

  {
    const repo = repositories();
    const router = new AiProviderRouter(baseConfig, repo.settings, repo.budget, {
      usageClient: { async getTodaySnapshot() { throw new AiRequestError("network", "usage down"); } },
      async openAiChat() { throw new Error("unexpected"); },
      async deepSeekChat() { return { content: "fallback", ms: 1, model: "deepseek-fallback" }; },
    });
    const result = await router.chat("guild", "answer", [{ role: "user", content: "x" }], { thinking: true });
    assert.equal(result.fallbackReason, "usage_unavailable");
  }

  {
    const repo = repositories();
    const router = new AiProviderRouter(baseConfig, repo.settings, repo.budget, {
      usageClient: { async getTodaySnapshot() { return { usageDate: "2026-07-10", organizationTokens: 1, botProjectTokens: 1 }; } },
      async openAiChat() { throw new AiRequestError("http_status", "rate", { status: 429 }); },
      async deepSeekChat() { return { content: "fallback", ms: 1, model: "deepseek-fallback" }; },
      reservationId: () => "r1",
    });
    const result = await router.chat("guild", "answer", [{ role: "user", content: "x" }], { thinking: true });
    assert.equal(result.fallbackReason, "openai_429");
    assert.ok(repo.calls.includes("release"));
  }

  {
    const repo = repositories();
    const models: string[] = [];
    let reservationSequence = 0;
    const router = new AiProviderRouter(baseConfig, repo.settings, repo.budget, {
      usageClient: { async getTodaySnapshot() { return { usageDate: "2026-07-10", organizationTokens: 1, botProjectTokens: 1 }; } },
      async openAiChat(_messages, _options, model) {
        models.push(model);
        if (model === "gpt-5.6-terra") {
          throw new AiRequestError("http_status", "model unavailable", { status: 400, apiCode: "model_not_found" });
        }
        return { content: "mini", ms: 2, model: "gpt-5.4-mini-response", usageTotalTokens: 25 };
      },
      async deepSeekChat() { throw new Error("unexpected"); },
      reservationId: () => `model-r${++reservationSequence}`,
    });
    const result = await router.chat("guild", "answer", [{ role: "user", content: "x" }], { thinking: true });
    assert.equal(result.provider, "openai");
    assert.equal(result.model, "gpt-5.4-mini-response");
    assert.equal(result.fallbackReason, "openai_model_fallback");
    assert.deepEqual(models, ["gpt-5.6-terra", "gpt-5.4-mini-2026-03-17"]);
    assert.ok(repo.calls.includes("release"));
    assert.ok(repo.calls.includes("settle:25"));
  }

  {
    const repo = repositories();
    const models: string[] = [];
    let reservationSequence = 0;
    const router = new AiProviderRouter(baseConfig, repo.settings, repo.budget, {
      usageClient: { async getTodaySnapshot() { return { usageDate: "2026-07-10", organizationTokens: 1, botProjectTokens: 1 }; } },
      async openAiChat(_messages, _options, model) {
        models.push(model);
        throw new AiRequestError("http_status", "model unavailable", { status: 404, apiCode: "model_not_found" });
      },
      async deepSeekChat() { return { content: "fallback", ms: 1, model: "deepseek-fallback" }; },
      reservationId: () => `failed-model-r${++reservationSequence}`,
    });
    const result = await router.chat("guild", "answer", [{ role: "user", content: "x" }], { thinking: true });
    assert.equal(result.provider, "deepseek");
    assert.equal(result.fallbackReason, "openai_model_unavailable");
    assert.deepEqual(models, ["gpt-5.6-terra", "gpt-5.4-mini-2026-03-17"]);
  }

  {
    const repo = repositories();
    const router = new AiProviderRouter(baseConfig, repo.settings, repo.budget, {
      usageClient: { async getTodaySnapshot() { return { usageDate: "2026-07-10", organizationTokens: 1, botProjectTokens: 1 }; } },
      async openAiChat() { throw new AiRequestError("network", "unknown delivery"); },
      async deepSeekChat() { return { content: "fallback", ms: 1, model: "deepseek-fallback" }; },
      reservationId: () => "r1",
    });
    await router.chat("guild", "answer", [{ role: "user", content: "x" }], { thinking: true });
    assert.ok(repo.calls.includes("consume"));
  }

  {
    const repo = repositories();
    const models: string[] = [];
    const router = new AiProviderRouter(baseConfig, repo.settings, repo.budget, {
      usageClient: { async getTodaySnapshot() { return { usageDate: "2026-07-10", organizationTokens: 1, botProjectTokens: 1 }; } },
      async openAiChat(_messages, _options, model) {
        models.push(model);
        throw new AiRequestError("http_status", "request timeout", { status: 408 });
      },
      async deepSeekChat() { return { content: "fallback", ms: 1, model: "deepseek-fallback" }; },
      reservationId: () => "r1",
    });
    const result = await router.chat("guild", "answer", [{ role: "user", content: "x" }], { thinking: true });
    assert.equal(result.fallbackReason, "openai_408");
    assert.deepEqual(models, ["gpt-5.6-terra"]);
    assert.ok(repo.calls.includes("consume"));
    assert.equal(repo.calls.includes("release"), false);
  }

  {
    const repo = repositories();
    let deepSeekCalls = 0;
    repo.budget.settle = async () => { throw new Error("database unavailable"); };
    const router = new AiProviderRouter(baseConfig, repo.settings, repo.budget, {
      usageClient: { async getTodaySnapshot() { return { usageDate: "2026-07-10", organizationTokens: 1, botProjectTokens: 1 }; } },
      async openAiChat() { return { content: "terra", ms: 1, model: "gpt-5.6-terra-response", usageTotalTokens: 10 }; },
      async deepSeekChat() { deepSeekCalls += 1; return { content: "fallback", ms: 1, model: "deepseek-fallback" }; },
      reservationId: () => "r1",
    });
    await assert.rejects(
      router.chat("guild", "answer", [{ role: "user", content: "x" }], { thinking: true }),
      /database unavailable/,
    );
    assert.equal(deepSeekCalls, 0);
  }

  {
    const repo = repositories();
    const router = new AiProviderRouter(baseConfig, repo.settings, repo.budget, {
      usageClient: { async getTodaySnapshot() { return { usageDate: "2026-07-10", organizationTokens: 1, botProjectTokens: 1 }; } },
      async openAiChat() { throw new AiRequestError("http_status", "bad input", { status: 422 }); },
      async deepSeekChat() { throw new Error("unexpected"); },
      reservationId: () => "r1",
    });
    await assert.rejects(
      router.chat("guild", "answer", [{ role: "user", content: "x" }], { thinking: true }),
      (error: unknown) => error instanceof AiRequestError && error.status === 422,
    );
    assert.ok(repo.calls.includes("release"));
  }

  {
    const repo = repositories();
    const controller = new AbortController();
    controller.abort();
    const router = new AiProviderRouter(baseConfig, repo.settings, repo.budget, {
      usageClient: { async getTodaySnapshot() { throw new Error("must not inspect usage"); } },
      async openAiChat() { throw new Error("unexpected"); },
      async deepSeekChat() { throw new Error("unexpected"); },
    });
    await assert.rejects(
      router.chat("guild", "answer", [{ role: "user", content: "x" }], { thinking: true, signal: controller.signal }),
      (error: unknown) => error instanceof AiRequestError && error.kind === "caller_abort",
    );
    assert.deepEqual(repo.calls, []);
  }

  console.log("aiProviderRouter.spec.ts: all assertions passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

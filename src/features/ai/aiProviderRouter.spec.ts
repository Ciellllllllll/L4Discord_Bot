import assert from "node:assert/strict";
import { AiProviderRouter } from "./aiProviderRouter.js";
import { AiRequestError } from "./aiRequestError.js";
import type {
  AiProviderBudgetRepository,
  AiProviderSettingsRepository,
  AiTokenReservation,
} from "./aiProviderRepository.js";

const baseConfig = {
  OPENAI_API_KEY: "openai",
  OPENAI_ADMIN_KEY: "admin",
  OPENAI_PROJECT_ID: "project",
  OPENAI_API_BASE: "https://api.openai.test/v1",
  OPENAI_MODEL: "gpt-5.6-terra",
  OPENAI_REASONING_EFFORT: "high" as const,
  OPENAI_FALLBACK_THRESHOLD: 2_400_000,
  OPENAI_USAGE_CACHE_MS: 30_000,
  OPENAI_MAX_COMPLETION_TOKENS: 8_192,
  AI_REQUEST_TIMEOUT_MS: 1_000,
  AI_MAX_RESPONSE_BYTES: 10_000,
  DEEPSEEK_MODEL: "deepseek-v4-flash",
  SENRYU_AI_REVIEW_MODEL: "senryu-legacy",
};

function repositories(preferred: "openai" | "deepseek" = "openai") {
  let selected = preferred;
  const calls: string[] = [];
  const settings: AiProviderSettingsRepository = {
    async getPreferredProvider() { return selected; },
    async setPreferredProvider(_guildId, provider) { selected = provider; },
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
      async openAiChat(_messages, options) {
        openAiCalls += 1;
        assert.equal(options.maxOutputTokens, 512);
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
    const repo = repositories("deepseek");
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
    assert.equal(result.fallbackReason, "manual_deepseek");
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
    const router = new AiProviderRouter(baseConfig, repo.settings, repo.budget, {
      usageClient: { async getTodaySnapshot() { return { usageDate: "2026-07-10", organizationTokens: 1, botProjectTokens: 1 }; } },
      async openAiChat() { throw new AiRequestError("http_status", "model unavailable", { status: 400, apiCode: "model_not_found" }); },
      async deepSeekChat() { return { content: "fallback", ms: 1, model: "deepseek-fallback" }; },
      reservationId: () => "r1",
    });
    const result = await router.chat("guild", "answer", [{ role: "user", content: "x" }], { thinking: true });
    assert.equal(result.fallbackReason, "openai_model_unavailable");
    assert.ok(repo.calls.includes("release"));
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
    const router = new AiProviderRouter(baseConfig, repo.settings, repo.budget, {
      usageClient: { async getTodaySnapshot() { return { usageDate: "2026-07-10", organizationTokens: 1, botProjectTokens: 1 }; } },
      async openAiChat() { throw new AiRequestError("http_status", "request timeout", { status: 408 }); },
      async deepSeekChat() { return { content: "fallback", ms: 1, model: "deepseek-fallback" }; },
      reservationId: () => "r1",
    });
    const result = await router.chat("guild", "answer", [{ role: "user", content: "x" }], { thinking: true });
    assert.equal(result.fallbackReason, "openai_408");
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

import { AiRequestError } from "./aiRequestError.js";
import { fetchWithLimits, type FetchWithLimitsOptions } from "./fetchWithLimits.js";

export type OpenAiUsageConfig = {
  adminKey: string;
  apiBase: string;
  projectId: string;
  cacheMs: number;
  timeoutMs: number;
  maxResponseBytes: number;
};

export type OpenAiUsageSnapshot = {
  usageDate: string;
  organizationTokens: number;
  botProjectTokens: number;
};

type LimitedFetcher = (
  url: string,
  init: RequestInit,
  options: FetchWithLimitsOptions,
) => Promise<Response>;

export type OpenAiUsageDeps = {
  fetcher?: LimitedFetcher;
  now?: () => number;
};

const TERRA_SHARED_GROUP_MODELS = new Set([
  "gpt-5.4-mini-2026-03-17",
  "gpt-5.4-nano-2026-03-17",
  "gpt-5.1-codex-mini",
  "gpt-5-mini-2025-08-07",
  "gpt-5-nano-2025-08-07",
  "gpt-4.1-mini-2025-04-14",
  "gpt-4.1-nano-2025-04-14",
  "gpt-4o-mini-2024-07-18",
  "o4-mini-2025-04-16",
  "o1-mini-2024-09-12",
  "codex-mini-latest",
]);

function isTerraSharedGroupModel(model: string): boolean {
  return model === "gpt-5.6-terra"
    || model.startsWith("gpt-5.6-terra-")
    || model === "gpt-5.6-luna"
    || model.startsWith("gpt-5.6-luna-")
    || TERRA_SHARED_GROUP_MODELS.has(model);
}

function utcDateParts(nowMs: number): { usageDate: string; startSeconds: number; endSeconds: number } {
  const now = new Date(nowMs);
  const usageDate = now.toISOString().slice(0, 10);
  const startSeconds = Date.parse(`${usageDate}T00:00:00.000Z`) / 1000;
  return { usageDate, startSeconds, endSeconds: Math.floor(nowMs / 1000) };
}

function nonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function pageUsage(body: unknown, botProjectId: string): {
  organizationTokens: number;
  botProjectTokens: number;
  hasMore: boolean;
  nextPage?: string;
} {
  if (!body || typeof body !== "object") {
    throw new AiRequestError("invalid_response", "OpenAI Usage API returned an invalid object.");
  }
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.data)) {
    throw new AiRequestError("invalid_response", "OpenAI Usage API response did not contain data.");
  }
  let organizationTokens = 0;
  let botProjectTokens = 0;
  for (const bucket of record.data) {
    if (!bucket || typeof bucket !== "object") continue;
    const results = (bucket as Record<string, unknown>).results;
    if (!Array.isArray(results)) continue;
    for (const result of results) {
      if (!result || typeof result !== "object") continue;
      const row = result as Record<string, unknown>;
      const model = typeof row.model === "string" ? row.model : "";
      if (!isTerraSharedGroupModel(model)) continue;
      const tokens = nonNegativeInt(row.input_tokens) + nonNegativeInt(row.output_tokens);
      organizationTokens += tokens;
      if (row.project_id === botProjectId) botProjectTokens += tokens;
    }
  }
  const next = typeof record.next_page === "string" && record.next_page ? record.next_page : undefined;
  return {
    organizationTokens,
    botProjectTokens,
    hasMore: record.has_more === true,
    nextPage: next,
  };
}

export class OpenAiUsageClient {
  private readonly fetcher: LimitedFetcher;
  private readonly now: () => number;
  private cached?: { expiresAt: number; value: OpenAiUsageSnapshot };
  private inFlight?: Promise<OpenAiUsageSnapshot>;

  constructor(
    private readonly config: OpenAiUsageConfig,
    deps: OpenAiUsageDeps = {},
  ) {
    this.fetcher = deps.fetcher ?? fetchWithLimits;
    this.now = deps.now ?? Date.now;
  }

  async getTodaySnapshot(): Promise<OpenAiUsageSnapshot> {
    const nowMs = this.now();
    const today = new Date(nowMs).toISOString().slice(0, 10);
    if (this.cached && this.cached.expiresAt > nowMs && this.cached.value.usageDate === today) {
      return this.cached.value;
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetchSnapshot(nowMs);
    try {
      const value = await this.inFlight;
      this.cached = { expiresAt: nowMs + this.config.cacheMs, value };
      return value;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async fetchSnapshot(nowMs: number): Promise<OpenAiUsageSnapshot> {
    const adminKey = this.config.adminKey.trim();
    const projectId = this.config.projectId.trim();
    if (!adminKey || !projectId) {
      throw new AiRequestError("configuration", "OPENAI_ADMIN_KEY and OPENAI_PROJECT_ID are required.");
    }
    const { usageDate, startSeconds, endSeconds } = utcDateParts(nowMs);
    let page: string | undefined;
    let organizationTokens = 0;
    let botProjectTokens = 0;
    do {
      const url = new URL(`${this.config.apiBase.trim().replace(/\/+$/, "")}/organization/usage/completions`);
      url.searchParams.set("start_time", String(startSeconds));
      url.searchParams.set("end_time", String(endSeconds));
      url.searchParams.set("bucket_width", "1d");
      url.searchParams.set("limit", "1");
      url.searchParams.append("group_by", "model");
      url.searchParams.append("group_by", "project_id");
      if (page) url.searchParams.set("page", page);

      let response: Response;
      try {
        response = await this.fetcher(
          url.toString(),
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${adminKey}`,
              "Content-Type": "application/json",
            },
          },
          {
            timeoutMs: this.config.timeoutMs,
            maxResponseBytes: this.config.maxResponseBytes,
          },
        );
      } catch (error) {
        throw new AiRequestError("network", "OpenAI Usage API request failed.", { cause: error });
      }
      if (!response.ok) {
        throw new AiRequestError("http_status", `OpenAI Usage API HTTP ${response.status}.`, {
          status: response.status,
        });
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        throw new AiRequestError("invalid_response", "OpenAI Usage API returned invalid JSON.", { cause: error });
      }
      const parsed = pageUsage(body, projectId);
      organizationTokens += parsed.organizationTokens;
      botProjectTokens += parsed.botProjectTokens;
      if (parsed.hasMore && !parsed.nextPage) {
        throw new AiRequestError("invalid_response", "OpenAI Usage API pagination cursor was missing.");
      }
      page = parsed.hasMore ? parsed.nextPage : undefined;
    } while (page);

    return { usageDate, organizationTokens, botProjectTokens };
  }
}

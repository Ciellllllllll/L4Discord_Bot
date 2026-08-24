import type { GithubPagePreview, GithubReplyTarget } from "./githubPreviewSource.js";

const API_BASE_URL = "https://api.github.com";
const API_VERSION = "2022-11-28";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000;

export type GithubApiErrorReason =
  | "private_repository"
  | "not_found"
  | "forbidden"
  | "rate_limited"
  | "timeout"
  | "response_too_large"
  | "invalid_json"
  | "request_failed"
  | "api_error"
  | "invalid_response";

export type GithubApiResult =
  | { status: "ok"; preview: GithubPagePreview }
  | { status: "error"; reason: GithubApiErrorReason; statusCode?: number };

export type GithubApiClientOptions = {
  token?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetcher?: typeof fetch;
};

type JsonResult =
  | { status: "ok"; value: Record<string, unknown> }
  | { status: "error"; reason: GithubApiErrorReason; statusCode?: number };

type ResponseBodyResult =
  | { status: "ok"; text: string }
  | { status: "error"; reason: "response_too_large" };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function authorValue(value: unknown): { name: string; avatarUrl?: string } | undefined {
  const item = record(value);
  const name = stringValue(item?.login) ?? stringValue(item?.name);
  if (!name) return undefined;
  const avatarUrl = stringValue(item?.avatar_url);
  return { name, ...(avatarUrl ? { avatarUrl } : {}) };
}

function repositoryPath(target: GithubReplyTarget): string {
  return `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repository)}`;
}

function endpointForTarget(target: GithubReplyTarget): string {
  const base = repositoryPath(target);
  if (target.kind === "repository") return base;
  if (target.kind === "issue") return `${base}/issues/${target.number}`;
  if (target.kind === "pull") return `${base}/pulls/${target.number}`;
  if (target.kind === "release") {
    return target.canonicalUrl.endsWith("/releases/latest")
      ? `${base}/releases/latest`
      : `${base}/releases/tags/${encodeURIComponent(target.tag ?? "")}`;
  }
  if (target.kind === "commit") return `${base}/commits/${encodeURIComponent(target.sha ?? "")}`;
  const path = (target.path ?? "").split("/").map((part) => encodeURIComponent(part)).join("/");
  return `${base}/contents/${path}?ref=${encodeURIComponent(target.ref ?? "")}`;
}

function mapStatus(status: number, headers?: Headers): GithubApiErrorReason {
  if (status === 404) return "not_found";
  if (status === 403) return headers?.get("x-ratelimit-remaining")?.trim() === "0" ? "rate_limited" : "forbidden";
  if (status === 429) return "rate_limited";
  return "api_error";
}

async function readResponseBody(response: Response, maxBytes: number): Promise<ResponseBodyResult> {
  if (!response.body) {
    const text = await response.text();
    return Buffer.byteLength(text, "utf8") > maxBytes
      ? { status: "error", reason: "response_too_large" }
      : { status: "ok", text };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        try { await reader.cancel(); } catch {}
        return { status: "error", reason: "response_too_large" };
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return { status: "ok", text: Buffer.concat(chunks).toString("utf8") };
}

function normalizeRepository(target: GithubReplyTarget, value: Record<string, unknown>): GithubPagePreview {
  const owner = authorValue(value.owner) ?? { name: target.owner };
  const license = record(value.license);
  return {
    kind: "repository",
    canonicalUrl: target.canonicalUrl,
    owner: target.owner,
    repository: target.repository,
    title: stringValue(value.full_name) ?? `${target.owner}/${target.repository}`,
    description: stringValue(value.description) ?? "",
    author: owner,
    stats: {
      ...(numberValue(value.stargazers_count) !== undefined ? { stars: numberValue(value.stargazers_count) } : {}),
      ...(numberValue(value.forks_count) !== undefined ? { forks: numberValue(value.forks_count) } : {}),
      ...(numberValue(value.open_issues_count) !== undefined ? { openIssues: numberValue(value.open_issues_count) } : {}),
    },
    ...(stringValue(value.language) ? { language: stringValue(value.language) } : {}),
    ...(stringValue(license?.spdx_id) ? { license: stringValue(license?.spdx_id) } : {}),
    ...(stringValue(value.default_branch) ? { defaultBranch: stringValue(value.default_branch) } : {}),
    ...(stringValue(value.updated_at) ? { updatedAt: stringValue(value.updated_at) } : {}),
    ...(booleanValue(value.archived) !== undefined ? { archived: booleanValue(value.archived) } : {}),
    ...(booleanValue(value.fork) !== undefined ? { fork: booleanValue(value.fork) } : {}),
  };
}

function labelsValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
      const label = record(item);
      const name = stringValue(label?.name);
      return name ? [name] : [];
    })
    : [];
}

function normalizeIssue(target: GithubReplyTarget, value: Record<string, unknown>, kind: "issue" | "pull"): GithubPagePreview | null {
  const number = numberValue(value.number) ?? target.number;
  const title = stringValue(value.title);
  if (!number || !title) return null;
  const user = authorValue(value.user);
  const stats = {
    ...(numberValue(value.additions) !== undefined ? { additions: numberValue(value.additions) } : {}),
    ...(numberValue(value.deletions) !== undefined ? { deletions: numberValue(value.deletions) } : {}),
    ...(numberValue(value.changed_files) !== undefined ? { changedFiles: numberValue(value.changed_files) } : {}),
    ...(numberValue(value.commits) !== undefined ? { commits: numberValue(value.commits) } : {}),
    ...(booleanValue(value.merged) !== undefined ? { merged: booleanValue(value.merged) } : {}),
  };
  return {
    kind,
    canonicalUrl: target.canonicalUrl,
    owner: target.owner,
    repository: target.repository,
    title,
    description: stringValue(value.body) ?? "",
    number,
    state: stringValue(value.state) ?? "unknown",
    labels: labelsValue(value.labels),
    ...(user ? { author: user } : {}),
    ...(numberValue(value.comments) !== undefined ? { comments: numberValue(value.comments) } : {}),
    ...(stringValue(value.created_at) ? { createdAt: stringValue(value.created_at) } : {}),
    ...(stringValue(value.updated_at) ? { updatedAt: stringValue(value.updated_at) } : {}),
    ...(Object.keys(stats).length > 0 ? { stats } : {}),
    ...(booleanValue(value.draft) !== undefined ? { draft: booleanValue(value.draft) } : {}),
  };
}

function normalizeRelease(target: GithubReplyTarget, value: Record<string, unknown>): GithubPagePreview | null {
  const tag = stringValue(value.tag_name) ?? target.tag;
  if (!tag) return null;
  return {
    kind: "release",
    canonicalUrl: target.canonicalUrl,
    owner: target.owner,
    repository: target.repository,
    title: stringValue(value.name) ?? tag,
    description: stringValue(value.body) ?? "",
    tag,
    ...(authorValue(value.author) ? { author: authorValue(value.author) } : {}),
    ...(stringValue(value.published_at) ? { publishedAt: stringValue(value.published_at) } : {}),
    ...(booleanValue(value.prerelease) !== undefined ? { prerelease: booleanValue(value.prerelease) } : {}),
    ...(booleanValue(value.draft) !== undefined ? { draft: booleanValue(value.draft) } : {}),
  };
}

function normalizeCommit(target: GithubReplyTarget, value: Record<string, unknown>): GithubPagePreview | null {
  const sha = stringValue(value.sha) ?? target.sha;
  const commit = record(value.commit);
  const message = stringValue(commit?.message);
  if (!sha || !message) return null;
  const stats = record(value.stats);
  const author = authorValue(value.author) ?? authorValue(commit?.author);
  const commitAuthor = record(commit?.author);
  const files = Array.isArray(value.files)
    ? value.files.flatMap((item) => {
      const file = record(item);
      const filename = stringValue(file?.filename);
      return filename ? [{
        filename,
        ...(stringValue(file?.status) ? { status: stringValue(file?.status) } : {}),
        ...(numberValue(file?.additions) !== undefined ? { additions: numberValue(file?.additions) } : {}),
        ...(numberValue(file?.deletions) !== undefined ? { deletions: numberValue(file?.deletions) } : {}),
        ...(numberValue(file?.changes) !== undefined ? { changes: numberValue(file?.changes) } : {}),
      }] : [];
    })
    : [];
  return {
    kind: "commit",
    canonicalUrl: target.canonicalUrl,
    owner: target.owner,
    repository: target.repository,
    title: message.split("\n", 1)[0] ?? message,
    sha,
    message,
    ...(author ? { author } : {}),
    ...(stats ? {
      stats: {
        ...(numberValue(stats.additions) !== undefined ? { additions: numberValue(stats.additions) } : {}),
        ...(numberValue(stats.deletions) !== undefined ? { deletions: numberValue(stats.deletions) } : {}),
        ...(numberValue(stats.total) !== undefined ? { total: numberValue(stats.total) } : {}),
      },
    } : {}),
    ...(files.length > 0 ? { files } : {}),
    ...(stringValue(commitAuthor?.date) ? { committedAt: stringValue(commitAuthor?.date) } : {}),
  };
}

function normalizeFile(target: GithubReplyTarget, value: Record<string, unknown>): GithubPagePreview | null {
  if (value.type !== "file" || value.encoding !== "base64") return null;
  const content = stringValue(value.content);
  const path = stringValue(value.path) ?? target.path;
  const ref = target.ref;
  if (!content || !path || !ref) return null;
  let code: string;
  try {
    code = Buffer.from(content.replace(/\s+/gu, ""), "base64").toString("utf8");
  } catch {
    return null;
  }
  return {
    kind: "file",
    canonicalUrl: target.canonicalUrl,
    owner: target.owner,
    repository: target.repository,
    title: path,
    path,
    ref,
    code: code.slice(0, 2_000),
    ...(stringValue(value.language) ? { language: stringValue(value.language) } : {}),
    ...(numberValue(value.size) !== undefined ? { size: numberValue(value.size) } : {}),
    ...(stringValue(value.sha) ? { sha: stringValue(value.sha) } : {}),
  };
}

export class GithubApiClient {
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetcher: typeof fetch;

  constructor(options: GithubApiClientOptions = {}) {
    this.token = String(options.token ?? "").trim();
    this.timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
      ? options.timeoutMs!
      : DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = Number.isFinite(options.maxResponseBytes) && (options.maxResponseBytes ?? 0) > 0
      ? options.maxResponseBytes!
      : DEFAULT_MAX_RESPONSE_BYTES;
    this.fetcher = options.fetcher ?? fetch;
  }

  private async getJson(path: string): Promise<JsonResult> {
    const controller = new AbortController();
    let timedOut = false;
    const headers = new Headers({
      accept: "application/vnd.github+json",
      "x-github-api-version": API_VERSION,
      "user-agent": "L4DiscordBot",
    });
    if (this.token) headers.set("authorization", `Bearer ${this.token}`);
    const request = (async (): Promise<JsonResult> => {
      const response = await this.fetcher(`${API_BASE_URL}${path}`, {
        headers,
        signal: controller.signal,
        redirect: "error",
      });
      const length = response.headers.get("content-length");
      if (length && Number(length) > this.maxResponseBytes) return { status: "error", reason: "response_too_large" };
      const bodyResult = await readResponseBody(response, this.maxResponseBytes);
      if (bodyResult.status === "error") return bodyResult;
      const body = bodyResult.text;
      if (!response.ok) return { status: "error", reason: mapStatus(response.status, response.headers), statusCode: response.status };
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return { status: "error", reason: "invalid_json", statusCode: response.status };
      }
      const value = record(parsed);
      return value ? { status: "ok", value } : { status: "error", reason: "invalid_response" };
    })();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<JsonResult>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error("github request timeout"));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([request, timeout]);
    } catch (error) {
      if (timedOut) return { status: "error", reason: "timeout" };
      return { status: "error", reason: "request_failed" };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      controller.abort();
    }
  }

  async fetchPreview(target: GithubReplyTarget): Promise<GithubApiResult> {
    const repositoryResult = await this.getJson(repositoryPath(target));
    if (repositoryResult.status !== "ok") return repositoryResult;
    const repository = repositoryResult.value;
    const visibility = stringValue(repository.visibility);
    const isPublicRepository = repository.private === false
      ? visibility === undefined || visibility === "public"
      : repository.private !== true && visibility === "public";
    if (!isPublicRepository) {
      return { status: "error", reason: "private_repository" };
    }
    if (target.kind === "repository") return { status: "ok", preview: normalizeRepository(target, repository) };
    const pageResult = await this.getJson(endpointForTarget(target));
    if (pageResult.status !== "ok") return pageResult;
    const preview = target.kind === "issue"
      ? normalizeIssue(target, pageResult.value, "issue")
      : target.kind === "pull"
        ? normalizeIssue(target, pageResult.value, "pull")
        : target.kind === "release"
          ? normalizeRelease(target, pageResult.value)
          : target.kind === "commit"
            ? normalizeCommit(target, pageResult.value)
            : normalizeFile(target, pageResult.value);
    return preview ? { status: "ok", preview } : { status: "error", reason: "invalid_response" };
  }
}

export const githubApiConstants = {
  apiBaseUrl: API_BASE_URL,
  apiVersion: API_VERSION,
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  defaultMaxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
} as const;

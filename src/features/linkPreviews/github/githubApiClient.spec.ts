import assert from "node:assert/strict";
import { GithubApiClient } from "./githubApiClient.js";
import { parseGithubUrl } from "./githubPreviewSource.js";

function response(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

const repositoryTarget = parseGithubUrl("https://github.com/octo/hello")!;
const issueTarget = parseGithubUrl("https://github.com/octo/hello/issues/42")!;
const pullTarget = parseGithubUrl("https://github.com/octo/hello/pull/7")!;
const releaseTarget = parseGithubUrl("https://github.com/octo/hello/releases/tag/v1.2.3")!;
const releaseLatestTagTarget = parseGithubUrl("https://github.com/octo/hello/releases/tag/latest")!;
const commitTarget = parseGithubUrl("https://github.com/octo/hello/commit/0123456789abcdef0123456789abcdef01234567")!;
const fileTarget = parseGithubUrl("https://github.com/octo/hello/blob/main/src/index.ts")!;

{
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = new GithubApiClient({
    token: "ghp-public-only",
    fetcher: async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/repos/octo/hello")) {
        return response({
          private: false,
          visibility: "public",
          full_name: "octo/hello",
          name: "hello",
          owner: { login: "octo", avatar_url: "https://avatars.githubusercontent.com/u/1" },
          html_url: "https://github.com/octo/hello",
          description: "A useful project.",
          stargazers_count: 12,
          forks_count: 3,
          open_issues_count: 1,
          language: "TypeScript",
          default_branch: "main",
        });
      }
      return response({
        number: 42,
        title: "Fix the widget",
        html_url: "https://github.com/octo/hello/issues/42",
        state: "open",
        user: { login: "contributor", avatar_url: "https://avatars.githubusercontent.com/u/2" },
        body: "The widget is broken.",
        labels: [{ name: "bug", color: "d73a4a" }],
        comments: 2,
        created_at: "2026-08-20T00:00:00Z",
        updated_at: "2026-08-21T00:00:00Z",
      });
    },
  });
  const result = await client.fetchPreview(issueTarget);
  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    assert.equal(result.preview.kind, "issue");
    assert.equal(result.preview.description, "The widget is broken.");
  }
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.url, "https://api.github.com/repos/octo/hello");
  assert.equal(requests[1]?.url, "https://api.github.com/repos/octo/hello/issues/42");
  const headers = new Headers(requests[0]?.init?.headers);
  assert.equal(headers.get("accept"), "application/vnd.github+json");
  assert.equal(headers.get("x-github-api-version"), "2022-11-28");
  assert.equal(headers.get("authorization"), "Bearer ghp-public-only");
  assert.equal(headers.get("user-agent"), "L4DiscordBot");
  assert.equal(requests[0]?.init?.redirect, "error");
}

{
  const calls: string[] = [];
  const client = new GithubApiClient({
    fetcher: async (input) => {
      calls.push(String(input));
      return response({
        private: true,
        visibility: "private",
        full_name: "octo/secret",
        owner: { login: "octo" },
      });
    },
  });
  const result = await client.fetchPreview({ ...repositoryTarget, repository: "secret" });
  assert.equal(result.status, "error");
  if (result.status === "error") assert.equal(result.reason, "private_repository");
  assert.deepEqual(calls, ["https://api.github.com/repos/octo/secret"]);
}

{
  const client = new GithubApiClient({
    fetcher: async () => response({ full_name: "octo/unknown-visibility" }),
  });
  const result = await client.fetchPreview(repositoryTarget);
  assert.equal(result.status, "error");
  if (result.status === "error") assert.equal(result.reason, "private_repository");
}

for (const target of [pullTarget, releaseTarget, commitTarget, fileTarget]) {
  let calledUrl = "";
  const client = new GithubApiClient({
    fetcher: async (input) => {
      calledUrl = String(input);
      if (calledUrl.endsWith("/repos/octo/hello")) {
        return response({ private: false, visibility: "public", full_name: "octo/hello", owner: { login: "octo" } });
      }
      if (target.kind === "pull") return response({
        number: 7,
        title: "Pull widget",
        html_url: target.canonicalUrl,
        state: "open",
        user: { login: "contributor" },
        body: "Pull body",
        labels: [],
        additions: 2,
        deletions: 1,
        changed_files: 1,
        merged: false,
      });
      if (target.kind === "release") return response({
        tag_name: "v1.2.3",
        name: "Hello v1.2.3",
        html_url: target.canonicalUrl,
        author: { login: "octo" },
        body: "Release notes",
        prerelease: false,
        draft: false,
        published_at: "2026-08-22T00:00:00Z",
      });
      if (target.kind === "commit") return response({
        sha: "0123456789abcdef0123456789abcdef01234567",
        html_url: target.canonicalUrl,
        commit: { message: "Fix widget\n\nDetails", author: { name: "octo", date: "2026-08-22T00:00:00Z" } },
        author: { login: "octo" },
        stats: { additions: 2, deletions: 1, total: 3 },
        files: [{ filename: "src/index.ts", status: "modified", additions: 2, deletions: 1, changes: 3 }],
      });
      return response({
        type: "file",
        encoding: "base64",
        content: Buffer.from("const value = 1;\n").toString("base64"),
        name: "index.ts",
        path: "src/index.ts",
        sha: "file-sha",
        size: 16,
        html_url: target.canonicalUrl,
      });
    },
  });
  const result = await client.fetchPreview(target);
  assert.equal(result.status, "ok", target.kind);
  assert.match(calledUrl, new RegExp(target.kind === "pull"
    ? "/pulls/7$"
    : target.kind === "release"
      ? "/releases/tags/v1\.2\.3$"
      : target.kind === "commit"
        ? "/commits/0123456789abcdef0123456789abcdef01234567$"
        : "/contents/src/index\.ts\\?ref=main$"));
}

{
  const calls: string[] = [];
  const client = new GithubApiClient({
    fetcher: async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/repos/octo/hello")) return response({ private: false, visibility: "public" });
      return response({ tag_name: "latest", name: "Latest tag", body: "Notes", author: { login: "octo" } });
    },
  });
  const result = await client.fetchPreview(releaseLatestTagTarget);
  assert.equal(result.status, "ok");
  assert.equal(calls[1], "https://api.github.com/repos/octo/hello/releases/tags/latest");
}

{
  const client = new GithubApiClient({
    fetcher: async (input) => {
      const url = String(input);
      if (url.endsWith("/repos/octo/hello")) return response({ private: false, visibility: "public" });
      return response({ message: "Not Found" }, 404);
    },
  });
  const result = await client.fetchPreview(repositoryTarget);
  assert.equal(result.status, "ok");
  const notFound = await client.fetchPreview(issueTarget);
  assert.equal(notFound.status, "error");
  if (notFound.status === "error") assert.equal(notFound.reason, "not_found");
}

for (const status of [403, 429]) {
  const client = new GithubApiClient({
    fetcher: async (input) => String(input).endsWith("/repos/octo/hello")
      ? response({ private: false, visibility: "public" })
      : response({ message: "rate limited" }, status),
  });
  const result = await client.fetchPreview(issueTarget);
  assert.equal(result.status, "error");
  if (result.status === "error") assert.equal(result.reason, status === 403 ? "forbidden" : "rate_limited");
}

{
  const client = new GithubApiClient({
    fetcher: async (input) => String(input).endsWith("/repos/octo/hello")
      ? response({ private: false, visibility: "public" })
      : response({ message: "rate limited" }, 403, { "x-ratelimit-remaining": "0" }),
  });
  const result = await client.fetchPreview(issueTarget);
  assert.equal(result.status, "error");
  if (result.status === "error") assert.equal(result.reason, "rate_limited");
}

{
  const client = new GithubApiClient({
    timeoutMs: 1,
    fetcher: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "AbortError")), { once: true });
    }),
  });
  const result = await client.fetchPreview(repositoryTarget);
  assert.equal(result.status, "error");
  if (result.status === "error") assert.equal(result.reason, "timeout");
}

{
  const client = new GithubApiClient({
    timeoutMs: 1,
    fetcher: async () => await new Promise<Response>(() => {}),
  });
  const result = await client.fetchPreview(repositoryTarget);
  assert.equal(result.status, "error");
  if (result.status === "error") assert.equal(result.reason, "timeout");
}

{
  const client = new GithubApiClient({
    maxResponseBytes: 20,
    fetcher: async () => new Response(JSON.stringify({ private: false, visibility: "public", description: "too large" }), {
      status: 200,
      headers: { "content-type": "application/json", "content-length": "999" },
    }),
  });
  const result = await client.fetchPreview(repositoryTarget);
  assert.equal(result.status, "error");
  if (result.status === "error") assert.equal(result.reason, "response_too_large");
}

{
  const client = new GithubApiClient({
    maxResponseBytes: 20,
    fetcher: async () => response({ private: false, visibility: "public", description: "too large without a length header" }),
  });
  const result = await client.fetchPreview(repositoryTarget);
  assert.equal(result.status, "error");
  if (result.status === "error") assert.equal(result.reason, "response_too_large");
}

{
  const client = new GithubApiClient({
    fetcher: async (input) => String(input).endsWith("/repos/octo/hello")
      ? response({ private: false, visibility: "public" })
      : new Response("not json", { status: 200 }),
  });
  const result = await client.fetchPreview(issueTarget);
  assert.equal(result.status, "error");
  if (result.status === "error") assert.equal(result.reason, "invalid_json");
}

console.log("githubApiClient.spec.ts: all assertions passed");

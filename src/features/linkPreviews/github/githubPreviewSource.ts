import type { PreviewDocument, PreviewTextLine, PreviewTextPart } from "../shared/previewDocument.js";

const GITHUB_URL_PATTERN = /(?<url>(?:https?:\/\/)?(?:www\.)?github\.com\/[^\s<>\u3000]+)/giu;
const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);
const BARE_URL_BOUNDARY_CHARS = new Set(["<", "(", "[", "{", "\"", "'"]);
const TRIM_TAIL_CHARS = ".,!?;:)]}>,、。」』）\"'";
const MAX_CODE_CHARS = 2_000;

export type GithubPageKind = "repository" | "issue" | "pull" | "release" | "commit" | "file";

export type GithubReplyTarget = {
  canonicalUrl: string;
  kind: GithubPageKind;
  owner: string;
  repository: string;
  number?: number;
  tag?: string;
  sha?: string;
  ref?: string;
  path?: string;
};

export type GithubAuthor = {
  name: string;
  avatarUrl?: string;
};

type GithubPreviewBase = {
  kind: GithubPageKind;
  canonicalUrl: string;
  owner: string;
  repository: string;
  title: string;
  author?: GithubAuthor;
};

type GithubIssueOrPullPreview = GithubPreviewBase & {
  description: string;
  number: number;
  state: string;
  labels: string[];
  comments?: number;
  createdAt?: string;
  updatedAt?: string;
  stats?: { additions?: number; deletions?: number; changedFiles?: number; commits?: number; merged?: boolean };
  draft?: boolean;
};

export type GithubPagePreview =
  | (GithubPreviewBase & {
    kind: "repository";
    description: string;
    stats?: { stars?: number; forks?: number; openIssues?: number };
    language?: string;
    license?: string;
    defaultBranch?: string;
    updatedAt?: string;
    archived?: boolean;
    fork?: boolean;
  })
  | (GithubIssueOrPullPreview & { kind: "issue" })
  | (GithubIssueOrPullPreview & { kind: "pull" })
  | (GithubPreviewBase & {
    kind: "release";
    description: string;
    tag: string;
    publishedAt?: string;
    prerelease?: boolean;
    draft?: boolean;
  })
  | (GithubPreviewBase & {
    kind: "commit";
    sha: string;
    message: string;
    stats?: { additions?: number; deletions?: number; total?: number };
    files?: Array<{ filename: string; status?: string; additions?: number; deletions?: number; changes?: number }>;
    committedAt?: string;
  })
  | (GithubPreviewBase & {
    kind: "file";
    path: string;
    ref: string;
    code: string;
    language?: string;
    size?: number;
    sha?: string;
  });

function stripUrlTail(value: string): string {
  let url = String(value || "").trim();
  while (url && TRIM_TAIL_CHARS.includes(url[url.length - 1]!)) url = url.slice(0, -1);
  return url;
}

function ensureScheme(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function hasBoundary(content: string, index: number, raw: string): boolean {
  if (/^https?:\/\//i.test(raw) || index <= 0) return true;
  const previous = content[index - 1] ?? "";
  return /\s/u.test(previous) || previous === "\u3000" || BARE_URL_BOUNDARY_CHARS.has(previous);
}

function decoded(value: string): string | null {
  try {
    const result = decodeURIComponent(value);
    return result && !/[\u0000-\u001f\u007f]/u.test(result) ? result : null;
  } catch {
    return null;
  }
}

function safeRepositoryPart(value: string): boolean {
  return /^[A-Za-z0-9_.-]{1,100}$/u.test(value) && value !== "." && value !== "..";
}

function encodedPath(value: string): string {
  return value.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function canonicalBase(owner: string, repository: string): string {
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
}

function parsePath(pathname: string): string[] | null {
  const rawParts = pathname.split("/").filter(Boolean);
  const parts = rawParts.map(decoded);
  return parts.every((part): part is string => part !== null) ? parts as string[] : null;
}

export function parseGithubUrl(value: string): GithubReplyTarget | null {
  const originalUrl = stripUrlTail(String(value || ""));
  if (!originalUrl) return null;
  try {
    const parsed = new URL(ensureScheme(originalUrl));
    if (
      parsed.protocol !== "https:"
      || !GITHUB_HOSTS.has(parsed.hostname.toLowerCase())
      || parsed.port
      || parsed.username
      || parsed.password
    ) {
      return null;
    }
    const parts = parsePath(parsed.pathname);
    if (!parts || parts.length < 2 || !safeRepositoryPart(parts[0]!) || !safeRepositoryPart(parts[1]!)) return null;
    const owner = parts[0]!.toLowerCase();
    const repository = parts[1]!.toLowerCase();
    const base = canonicalBase(owner, repository);
    if (parts.length === 2) {
      return { canonicalUrl: base, kind: "repository", owner, repository };
    }

    const [section, valuePart, ...rest] = parts.slice(2);
    if (section === "issues" && rest.length === 0 && /^\d{1,12}$/u.test(valuePart ?? "")) {
      const number = Number(valuePart);
      return Number.isSafeInteger(number) && number > 0
        ? { canonicalUrl: `${base}/issues/${number}`, kind: "issue", owner, repository, number }
        : null;
    }
    if (section === "pull" && rest.length === 0 && /^\d{1,12}$/u.test(valuePart ?? "")) {
      const number = Number(valuePart);
      return Number.isSafeInteger(number) && number > 0
        ? { canonicalUrl: `${base}/pull/${number}`, kind: "pull", owner, repository, number }
        : null;
    }
    if (section === "releases" && valuePart === "latest" && rest.length === 0) {
      return { canonicalUrl: `${base}/releases/latest`, kind: "release", owner, repository, tag: "latest" };
    }
    if (section === "releases" && valuePart === "tag" && rest.length === 1 && rest[0]) {
      const tag = rest[0];
      if (tag.length > 200 || tag === "." || tag === "..") return null;
      return {
        canonicalUrl: `${base}/releases/tag/${encodeURIComponent(tag)}`,
        kind: "release",
        owner,
        repository,
        tag,
      };
    }
    if (section === "commit" && rest.length === 0 && /^[0-9a-f]{7,40}$/iu.test(valuePart ?? "")) {
      const sha = String(valuePart).toLowerCase();
      return { canonicalUrl: `${base}/commit/${sha}`, kind: "commit", owner, repository, sha };
    }
    if (section === "blob" && valuePart && rest.length > 0) {
      const path = rest.join("/");
      if (path.length > 500 || path.split("/").some((part) => part === "." || part === "..")) return null;
      return {
        canonicalUrl: `${base}/blob/${encodedPath(valuePart)}/${encodedPath(rest.join("/"))}`,
        kind: "file",
        owner,
        repository,
        ref: valuePart,
        path,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function extractGithubLinks(content: string): string[] {
  const links: string[] = [];
  for (const match of String(content || "").matchAll(GITHUB_URL_PATTERN)) {
    const raw = match.groups?.url ?? "";
    if (!hasBoundary(String(content || ""), match.index ?? 0, raw)) continue;
    const value = stripUrlTail(raw);
    if (value && parseGithubUrl(value)) links.push(value);
  }
  return links;
}

export function collectGithubReplyTargets(links: readonly string[]): GithubReplyTarget[] {
  const targets: GithubReplyTarget[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    const target = parseGithubUrl(link);
    if (!target || seen.has(target.canonicalUrl)) continue;
    seen.add(target.canonicalUrl);
    targets.push(target);
    if (targets.length >= 5) break;
  }
  return targets;
}

function compactText(value: string, maxLength: number): string {
  const normalized = String(value || "").replace(/\s+/gu, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function safeAvatarUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function authorPart(author: GithubAuthor | undefined): PreviewTextPart[] {
  return author?.name ? [{ text: author.name, strong: true }] : [{ text: "不明" }];
}

function dateText(value: string | undefined): string {
  if (!value) return "不明";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "不明" : date.toLocaleDateString("ja-JP", { timeZone: "UTC" });
}

function numberText(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("ja-JP") : "不明";
}

function summaryLine(preview: GithubPagePreview): PreviewTextLine {
  return {
    parts: [{ text: preview.title || `${preview.owner}/${preview.repository}`, strong: true }],
  };
}

function textBlock(preview: GithubPagePreview, lines: PreviewTextLine, ...rest: PreviewTextLine[]): PreviewDocument["blocks"][number] {
  const avatarUrl = safeAvatarUrl(preview.author?.avatarUrl);
  return {
    type: "text",
    id: "summary",
    lines: [lines, ...rest],
    ...(avatarUrl ? { thumbnailUrl: avatarUrl, thumbnailDescription: `${preview.author?.name ?? "GitHub"} avatar` } : {}),
  };
}

export function githubPreviewToDocument(preview: GithubPagePreview): PreviewDocument {
  let block: PreviewDocument["blocks"][number];
  if (preview.kind === "repository") {
    block = textBlock(
      preview,
      summaryLine(preview),
      ...(preview.description ? [{ prefix: "説明: ", parts: [{ text: compactText(preview.description, 3_000), translationKey: "description" }] }] : []),
      { prefix: "作成者: ", parts: authorPart(preview.author) },
      { prefix: "Stars: ", parts: [{ text: numberText(preview.stats?.stars) }] },
      { prefix: "Forks: ", parts: [{ text: numberText(preview.stats?.forks) }] },
      { prefix: "Open issues: ", parts: [{ text: numberText(preview.stats?.openIssues) }] },
      ...(preview.language ? [{ prefix: "言語: ", parts: [{ text: preview.language }] }] : []),
      ...(preview.defaultBranch ? [{ prefix: "既定ブランチ: ", parts: [{ text: preview.defaultBranch }] }] : []),
    );
  } else if (preview.kind === "issue" || preview.kind === "pull") {
    const kindLabel = preview.kind === "pull" ? "Pull Request" : "Issue";
    block = textBlock(
      preview,
      { parts: [{ text: `#${preview.number} ${kindLabel}: ${preview.title}`, strong: true }] },
      ...(preview.description ? [{ prefix: "本文: ", parts: [{ text: compactText(preview.description, 3_000), translationKey: "body" }] }] : []),
      { prefix: "状態: ", parts: [{ text: preview.state || "不明" }] },
      { prefix: "作成者: ", parts: authorPart(preview.author) },
      ...(preview.labels.length > 0 ? [{ prefix: "ラベル: ", parts: [{ text: preview.labels.join(", ") }] }] : []),
      ...(preview.kind === "pull" && preview.stats ? [{
        prefix: "変更: ",
        parts: [{ text: `+${numberText(preview.stats.additions)} / -${numberText(preview.stats.deletions)} (${numberText(preview.stats.changedFiles)} files)` }],
      }] : []),
      ...(typeof preview.comments === "number" ? [{ prefix: "コメント: ", parts: [{ text: numberText(preview.comments) }] }] : []),
    );
  } else if (preview.kind === "release") {
    block = textBlock(
      preview,
      { parts: [{ text: preview.title || preview.tag, strong: true }] },
      { prefix: "タグ: ", parts: [{ text: preview.tag }] },
      ...(preview.description ? [{ prefix: "本文: ", parts: [{ text: compactText(preview.description, 3_000), translationKey: "body" }] }] : []),
      { prefix: "作成者: ", parts: authorPart(preview.author) },
      { prefix: "公開日: ", parts: [{ text: dateText(preview.publishedAt) }] },
      ...(preview.prerelease ? [{ prefix: "状態: ", parts: [{ text: "Prerelease" }] }] : []),
    );
  } else if (preview.kind === "commit") {
    block = textBlock(
      preview,
      { parts: [{ text: compactText(preview.message, 2_000), strong: true }] },
      { prefix: "SHA: ", parts: [{ text: preview.sha }] },
      { prefix: "作成者: ", parts: authorPart(preview.author) },
      { prefix: "日時: ", parts: [{ text: dateText(preview.committedAt) }] },
      ...(preview.stats ? [{
        prefix: "変更: ",
        parts: [{ text: `+${numberText(preview.stats.additions)} / -${numberText(preview.stats.deletions)}` }],
      }] : []),
      ...(preview.files && preview.files.length > 0 ? [{
        prefix: "ファイル: ",
        parts: [{ text: `${numberText(preview.files.length)} 件` }],
      }] : []),
    );
  } else {
    const code = String(preview.code || "").slice(0, MAX_CODE_CHARS).replaceAll("```", "``\u200b`");
    block = textBlock(
      preview,
      { parts: [{ text: preview.title || preview.path, strong: true }] },
      { prefix: "パス: ", parts: [{ text: preview.path }] },
      { prefix: "Ref: ", parts: [{ text: preview.ref }] },
      ...(preview.language ? [{ prefix: "言語: ", parts: [{ text: preview.language }] }] : []),
      ...(typeof preview.size === "number" ? [{ prefix: "サイズ: ", parts: [{ text: `${numberText(preview.size)} bytes` }] }] : []),
    );
    return {
      version: 1,
      source: "github",
      url: preview.canonicalUrl,
      openLabel: "GitHubで開く",
      blocks: [block, {
        type: "text",
        id: "code",
        lines: [{ parts: [{ text: `\`\`\`${preview.language?.toLowerCase() ?? ""}\n${code}\n\`\`\`` }] }],
      }],
    };
  }

  return {
    version: 1,
    source: "github",
    url: preview.canonicalUrl,
    openLabel: "GitHubで開く",
    blocks: [block],
  };
}

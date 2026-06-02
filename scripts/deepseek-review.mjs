import { appendFileSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const {
  DEEPSEEK_API_KEY,
  DEEPSEEK_MODEL = "deepseek-v4-pro",
  DEEPSEEK_REASONING_EFFORT = "high",

  GITHUB_TOKEN,
  GITHUB_REPOSITORY,
  GITHUB_EVENT_NAME,
  GITHUB_REF_NAME,
  GITHUB_SERVER_URL = "https://github.com",
  GITHUB_RUN_ID,
  GITHUB_EVENT_PATH,

  PR_NUMBER,
  PR_HTML_URL,

  BEFORE_SHA,
  HEAD_SHA,

  DISCORD_REVIEW_WEBHOOK_URL,

  MAX_DIFF_CHARS = "180000",
  MAX_REPOSITORY_CHARS = "350000",
  MAX_REVIEW_COMMENTS = "80",
  MAX_DEEPSEEK_TOKENS = "12000",
  SKIP_PUSH_REVIEW_IF_OPEN_PR = "true",
} = process.env;

const maxDiffChars = Number(MAX_DIFF_CHARS);
const maxRepositoryChars = Number(MAX_REPOSITORY_CHARS);
const maxReviewComments = Number(MAX_REVIEW_COMMENTS);
const maxDeepSeekTokens = Number(MAX_DEEPSEEK_TOKENS);

function requireEnv(name, value) {
  if (!value) {
    throw new Error(`${name} is required`);
  }
}

requireEnv("DEEPSEEK_API_KEY", DEEPSEEK_API_KEY);
requireEnv("GITHUB_TOKEN", GITHUB_TOKEN);
requireEnv("GITHUB_REPOSITORY", GITHUB_REPOSITORY);
requireEnv("GITHUB_EVENT_NAME", GITHUB_EVENT_NAME);
requireEnv("HEAD_SHA", HEAD_SHA);

const [owner, repo] = GITHUB_REPOSITORY.split("/");
const isPullRequest = GITHUB_EVENT_NAME === "pull_request";
const isPush = GITHUB_EVENT_NAME === "push";
const isIssueComment = GITHUB_EVENT_NAME === "issue_comment";

function readGitHubEventPayload() {
  if (!GITHUB_EVENT_PATH) {
    return {};
  }

  try {
    return JSON.parse(readFileSync(GITHUB_EVENT_PATH, "utf8"));
  } catch (error) {
    console.warn("Failed to read GitHub event payload.");
    console.warn(error);
    return {};
  }
}

const eventPayload = readGitHubEventPayload();
const prNumber = PR_NUMBER || String(eventPayload.pull_request?.number ?? eventPayload.issue?.number ?? "");

if (isPullRequest || isIssueComment) {
  requireEnv("PR_NUMBER", prNumber);
}

function truncateText(text, maxLength) {
  const value = String(text ?? "");

  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n\n...省略されました...`;
}

function escapeMarkdownTableCell(text) {
  return String(text ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("\n", "<br>");
}

function escapeWorkflowCommandData(text) {
  return String(text ?? "")
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

function escapeWorkflowCommandProperty(text) {
  return String(text ?? "")
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A")
    .replaceAll(":", "%3A")
    .replaceAll(",", "%2C");
}

async function githubRequest(path, options = {}) {
  const url = path.startsWith("http")
    ? path
    : `https://api.github.com${path}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`GitHub API failed: ${response.status}\n${text}`);
  }

  if (!text) {
    return null;
  }

  return JSON.parse(text);
}

async function getPullRequestFiles() {
  const files = [];
  let page = 1;

  while (true) {
    const result = await githubRequest(
      `/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`,
    );

    files.push(...result);

    if (result.length < 100) {
      break;
    }

    page += 1;
  }

  return files;
}

async function getPushFiles() {
  if (BEFORE_SHA && !/^0+$/.test(BEFORE_SHA)) {
    const compare = await githubRequest(
      `/repos/${owner}/${repo}/compare/${BEFORE_SHA}...${HEAD_SHA}`,
    );

    return compare.files ?? [];
  }

  const commit = await githubRequest(
    `/repos/${owner}/${repo}/commits/${HEAD_SHA}`,
  );

  return commit.files ?? [];
}

async function getHeadCommit() {
  return githubRequest(
    `/repos/${owner}/${repo}/commits/${HEAD_SHA}`,
  );
}

async function getHeadCommitComments() {
  return githubRequest(
    `/repos/${owner}/${repo}/commits/${HEAD_SHA}/comments?per_page=100`,
  );
}

async function getPullRequest() {
  return githubRequest(`/repos/${owner}/${repo}/pulls/${prNumber}`);
}

async function getPullRequestIssueComments() {
  const comments = [];
  let page = 1;

  while (true) {
    const result = await githubRequest(
      `/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
    );

    comments.push(...result);

    if (result.length < 100) {
      break;
    }

    page += 1;
  }

  return comments;
}

function containsAllReviewDirective(text) {
  return /(^|\s)\/all(?=\s|$)/i.test(String(text ?? ""));
}

async function shouldReviewAllRepository() {
  const values = [eventPayload.comment?.body];

  try {
    const commit = await getHeadCommit();
    values.push(commit?.commit?.message);
  } catch (error) {
    console.warn("Failed to read head commit message for /all detection.");
    console.warn(error);
  }

  try {
    const comments = await getHeadCommitComments();
    values.push(...comments.map((comment) => comment.body));
  } catch (error) {
    console.warn("Failed to read head commit comments for /all detection.");
    console.warn(error);
  }

  if (isPullRequest || isIssueComment) {
    try {
      const pull = await getPullRequest();
      values.push(pull?.title, pull?.body);
    } catch (error) {
      console.warn("Failed to read pull request body for /all detection.");
      console.warn(error);
    }

    try {
      const comments = await getPullRequestIssueComments();
      values.push(...comments.map((comment) => comment.body));
    } catch (error) {
      console.warn("Failed to read pull request comments for /all detection.");
      console.warn(error);
    }
  }

  return values.some(containsAllReviewDirective);
}

async function hasOpenPullRequestForCommit() {
  try {
    const pulls = await githubRequest(
      `/repos/${owner}/${repo}/commits/${HEAD_SHA}/pulls`,
    );

    return Array.isArray(pulls) && pulls.some((pull) => pull.state === "open");
  } catch (error) {
    console.warn("Failed to check related pull requests. Continue push review.");
    console.warn(error);
    return false;
  }
}

function isReviewTargetPath(filename) {
  const excludedPatterns = [
    /^\.git\//,
    /^node_modules\//,
    /^dist\//,
    /^build\//,
    /^coverage\//,
    /^\.next\//,
    /^\.turbo\//,
    /^\.cache\//,
    /^data\//,
    /^\.env(?:\.|$)/,
    /package-lock\.json$/,
    /pnpm-lock\.yaml$/,
    /yarn\.lock$/,
    /\.lock$/,
    /\.(png|jpg|jpeg|gif|webp|ico|svg|mp4|mp3|wav|zip|pdf|ttf|otf|woff|woff2)$/i,
  ];

  return Boolean(filename) && !excludedPatterns.some((pattern) => pattern.test(filename));
}

function isReviewTargetFile(file) {
  if (!file.filename || !file.patch) {
    return false;
  }

  if (file.status === "removed") {
    return false;
  }

  return isReviewTargetPath(file.filename);
}

async function collectRepositoryFiles(dir = ".") {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = fullPath.split(path.sep).join("/");

    if (entry.isDirectory()) {
      if (!isReviewTargetPath(`${relativePath}/`)) {
        continue;
      }

      files.push(...await collectRepositoryFiles(fullPath));
      continue;
    }

    if (entry.isFile() && isReviewTargetPath(relativePath)) {
      files.push(relativePath);
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

async function buildRepositoryContextForPrompt() {
  const chunks = [];
  const lineCountsByPath = new Map();
  let totalLength = 0;
  let omittedCount = 0;

  for (const filename of await collectRepositoryFiles()) {
    let content;

    try {
      content = await readFile(filename, "utf8");
    } catch {
      omittedCount += 1;
      continue;
    }

    if (content.includes("\0")) {
      omittedCount += 1;
      continue;
    }

    const lineCount = content.length === 0 ? 1 : content.split("\n").length;
    lineCountsByPath.set(filename, lineCount);

    const chunk = [
      `FILE: ${filename}`,
      "CONTENT:",
      truncateText(content, 25000),
    ].join("\n");

    if (totalLength + chunk.length > maxRepositoryChars) {
      omittedCount += 1;
      continue;
    }

    chunks.push(chunk);
    totalLength += chunk.length;
  }

  const header = [
    "REPOSITORY SNAPSHOT:",
    `Included files: ${chunks.length}`,
    `Omitted files: ${omittedCount}`,
    "",
  ].join("\n");

  return {
    text: truncateText(`${header}${chunks.join("\n\n---\n\n")}`, maxRepositoryChars),
    lineCountsByPath,
  };
}

function buildLinePositionMap(patch) {
  const lineToPosition = new Map();
  const lines = patch.split("\n");

  let newLine = null;
  let position = 0;

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);

    if (hunkMatch) {
      newLine = Number(hunkMatch[1]);
      continue;
    }

    if (newLine === null) {
      continue;
    }

    if (line.startsWith("\\ No newline")) {
      continue;
    }

    position += 1;

    if (line.startsWith("+") && !line.startsWith("+++")) {
      lineToPosition.set(newLine, position);
      newLine += 1;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      continue;
    }

    lineToPosition.set(newLine, position);
    newLine += 1;
  }

  return lineToPosition;
}

function buildDiffForPrompt(files) {
  const chunks = files.map((file) => {
    return [
      `FILE: ${file.filename}`,
      `STATUS: ${file.status}`,
      `ADDITIONS: ${file.additions ?? "unknown"}`,
      `DELETIONS: ${file.deletions ?? "unknown"}`,
      "PATCH:",
      file.patch,
    ].join("\n");
  });

  return truncateText(chunks.join("\n\n---\n\n"), maxDiffChars);
}

function extractJson(text) {
  const trimmed = String(text ?? "").trim();

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return JSON.parse(trimmed);
  }

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);

  if (fenceMatch) {
    return JSON.parse(fenceMatch[1].trim());
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  }

  throw new Error("DeepSeek response did not contain JSON.");
}

async function requestDeepSeekReview(diffText, options = {}) {
  const reviewAll = Boolean(options.reviewAll);
  const repositoryText = options.repositoryText ?? "";
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      thinking: {
        type: "enabled",
      },
      reasoning_effort: DEEPSEEK_REASONING_EFFORT,
      response_format: {
        type: "json_object",
      },
      max_tokens: maxDeepSeekTokens,
      messages: [
        {
          role: "system",
          content: [
            "あなたはGitHub Pull RequestとPush差分をレビューするコードレビュアーです。",
            "出力は必ずJSONだけにしてください。",
            "日本語でレビューしてください。",
            "セキュリティ、APIキー漏洩、バグ、例外処理、型安全性、非同期処理、保守性、不要な複雑化、設定ミスを重点的に確認してください。",
            "根拠が弱い指摘は書かないでください。",
            reviewAll
              ? "コメント対象は入力されたリポジトリスナップショット内のファイル行、または差分上に存在する変更後ファイルの行だけにしてください。"
              : "コメント対象は差分上に存在する変更後ファイルの行だけにしてください。",
            reviewAll
              ? "未変更ファイルにも重大な問題があればコメントしてください。"
              : "削除された行にはコメントしないでください。",
            "pathは入力されたFILEの値と完全一致させてください。",
            reviewAll
              ? "lineはリポジトリスナップショット内のファイル行番号、または変更後ファイル上の行番号を指定してください。"
              : "lineは変更後ファイル上の行番号を指定してください。",
            "内部推論やchain-of-thoughtは出力しないでください。",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            reviewAll
              ? "以下のgit diffとリポジトリスナップショットをレビューしてください。"
              : "以下のgit diffをレビューしてください。",
            "",
            "次のJSON形式だけで返してください。",
            "",
            "{",
            '  "summary": "PRまたはPush全体の詳細な総評",',
            '  "risk_level": "low | medium | high",',
            '  "comments": [',
            "    {",
            '      "path": "対象ファイルの相対パス",',
            '      "line": 123,',
            '      "severity": "blocker | major | minor | nit",',
            '      "title": "短い指摘タイトル",',
            '      "body": "問題点、理由、修正案を含む詳細なレビュー本文"',
            "    }",
            "  ]",
            "}",
            "",
            `commentsは最大${maxReviewComments}件です。`,
            "重大な問題を優先してください。",
            "問題がない場合はcommentsを空配列にしてください。",
            "",
            "```diff",
            diffText,
            "```",
            reviewAll ? "" : null,
            reviewAll ? "```text" : null,
            reviewAll ? repositoryText : null,
            reviewAll ? "```" : null,
          ].filter((line) => line !== null).join("\n"),
        },
      ],
    }),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`DeepSeek API failed: ${response.status}\n${text}`);
  }

  const json = JSON.parse(text);
  const content = json.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("DeepSeek returned empty content.");
  }

  return extractJson(content);
}

function normalizeSeverity(severity) {
  const value = String(severity ?? "minor").trim().toLowerCase();
  const allowed = new Set(["blocker", "major", "minor", "nit"]);

  if (allowed.has(value)) {
    return value;
  }

  return "minor";
}

function formatSeverityLabel(severity) {
  const labels = {
    blocker: "致命的",
    major: "重大",
    minor: "軽微",
    nit: "細部",
  };

  return labels[severity] ?? "軽微";
}

function formatRiskLabel(risk) {
  const labels = {
    high: "高",
    medium: "中",
    low: "低",
  };

  return labels[String(risk ?? "").toLowerCase()] ?? "不明";
}

function formatRunModeLabel(mode) {
  const labels = {
    pull_request: "Pull Request",
    push: "Push",
    issue_comment: "Issueコメント",
  };

  return labels[mode] ?? mode;
}

function filterValidComments(rawComments, lineMapByPath) {
  const filtered = [];
  const seen = new Set();

  for (const rawComment of rawComments ?? []) {
    const path = String(rawComment.path ?? "").trim();
    const line = Number(rawComment.line);
    const body = String(rawComment.body ?? "").trim();
    const title = String(rawComment.title ?? "DeepSeekレビュー").trim();
    const severity = normalizeSeverity(rawComment.severity);

    if (!path || !Number.isInteger(line) || line <= 0 || !body) {
      continue;
    }

    const lineToPosition = lineMapByPath.get(path);

    if (!lineToPosition) {
      continue;
    }

    const position = lineToPosition.get(line);

    if (!position) {
      continue;
    }

    const key = `${path}:${line}:${title}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    filtered.push({
      path,
      line,
      position,
      severity,
      title: truncateText(title, 120),
      body: truncateText(body, 3000),
    });

    if (filtered.length >= maxReviewComments) {
      break;
    }
  }

  return filtered;
}

function filterRepositoryComments(rawComments, lineCountsByPath) {
  const filtered = [];
  const seen = new Set();

  for (const rawComment of rawComments ?? []) {
    const path = String(rawComment.path ?? "").trim();
    const line = Number(rawComment.line);
    const body = String(rawComment.body ?? "").trim();
    const title = String(rawComment.title ?? "DeepSeekレビュー").trim();
    const severity = normalizeSeverity(rawComment.severity);
    const lineCount = lineCountsByPath.get(path);

    if (!path || !Number.isInteger(line) || line <= 0 || !body || !lineCount || line > lineCount) {
      continue;
    }

    const key = `${path}:${line}:${title}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    filtered.push({
      path,
      line,
      severity,
      title: truncateText(title, 120),
      body: truncateText(body, 3000),
    });

    if (filtered.length >= maxReviewComments) {
      break;
    }
  }

  return filtered;
}

function formatInlineComment(comment) {
  return [
    `重要度: ${formatSeverityLabel(comment.severity)}`,
    "",
    `指摘: ${comment.title}`,
    "",
    comment.body,
  ].join("\n");
}

function formatCommentListForSummary(comments, maxItems = maxReviewComments) {
  if (comments.length === 0) {
    return "指摘はありません。";
  }

  return comments.slice(0, maxItems).map((comment) => {
    return [
      `- \`${formatSeverityLabel(comment.severity)}\` ${comment.path}:${comment.line} ${comment.title}`,
      `  ${truncateText(comment.body, 700).replaceAll("\n", "\n  ")}`,
    ].join("\n");
  }).join("\n");
}

function buildReviewSummaryBody(review, inlineComments, allComments, reviewAll) {
  return [
    "## DeepSeekコードレビュー",
    "",
    `モデル: \`${DEEPSEEK_MODEL}\``,
    `推論強度: \`${DEEPSEEK_REASONING_EFFORT}\``,
    `リスク: \`${formatRiskLabel(review.risk_level)}\``,
    `対象範囲: \`${reviewAll ? "リポジトリ全体" : "差分"}\``,
    `インラインコメント数: \`${inlineComments.length}\``,
    `指摘数: \`${allComments.length}\``,
    "",
    "## 総評",
    "",
    truncateText(review.summary ?? "総評はありません。", 12000),
    "",
    "## 指摘一覧",
    "",
    formatCommentListForSummary(allComments),
  ].join("\n");
}

async function createPullRequestReview(review, inlineComments, allComments, reviewAll) {
  const payload = {
    commit_id: HEAD_SHA,
    event: "COMMENT",
    body: buildReviewSummaryBody(review, inlineComments, allComments, reviewAll),
  };

  if (inlineComments.length > 0) {
    payload.comments = inlineComments.map((comment) => {
      return {
        path: comment.path,
        position: comment.position,
        body: formatInlineComment(comment),
      };
    });
  }

  return githubRequest(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

function emitPushAnnotations(comments) {
  let errorCount = 0;
  let warningCount = 0;
  const maxAnnotationsPerLevel = Math.max(10, maxReviewComments);

  for (const comment of comments) {
    const isError = comment.severity === "blocker" || comment.severity === "major";
    const level = isError ? "error" : "warning";

    if (isError && errorCount >= maxAnnotationsPerLevel) {
      continue;
    }

    if (!isError && warningCount >= maxAnnotationsPerLevel) {
      continue;
    }

    if (isError) {
      errorCount += 1;
    } else {
      warningCount += 1;
    }

    const command = [
      `::${level}`,
      ` file=${escapeWorkflowCommandProperty(comment.path)}`,
      `,line=${comment.line}`,
      `,title=${escapeWorkflowCommandProperty(`DeepSeek ${formatSeverityLabel(comment.severity)}: ${comment.title}`)}`,
      `::${escapeWorkflowCommandData(comment.body)}`,
    ].join("");

    console.log(command);
  }
}

function getRunUrl() {
  if (!GITHUB_RUN_ID) {
    return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}`;
  }

  return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
}

function getTargetUrl(reviewApiResult) {
  if (isPullRequest && reviewApiResult?.html_url) {
    return reviewApiResult.html_url;
  }

  if (isPullRequest && PR_HTML_URL) {
    return PR_HTML_URL;
  }

  return getRunUrl();
}

function writeStepSummary(review, comments, mode, targetUrl, reviewAll) {
  if (!process.env.GITHUB_STEP_SUMMARY) {
    return;
  }

  const rows = comments.map((comment) => {
    return [
      "|",
      escapeMarkdownTableCell(formatSeverityLabel(comment.severity)),
      "|",
      escapeMarkdownTableCell(comment.path),
      "|",
      comment.line,
      "|",
      escapeMarkdownTableCell(comment.title),
      "|",
      escapeMarkdownTableCell(truncateText(comment.body, 900)),
      "|",
    ].join(" ");
  });

  const summary = [
    "# DeepSeekコードレビュー",
    "",
    `実行モード: \`${formatRunModeLabel(mode)}\``,
    `対象範囲: \`${reviewAll ? "リポジトリ全体" : "差分"}\``,
    `モデル: \`${DEEPSEEK_MODEL}\``,
    `推論強度: \`${DEEPSEEK_REASONING_EFFORT}\``,
    `リスク: \`${formatRiskLabel(review.risk_level)}\``,
    `投稿先: ${targetUrl}`,
    "",
    "## 総評",
    "",
    truncateText(review.summary ?? "総評はありません。", 12000),
    "",
    "## 指摘一覧",
    "",
    comments.length > 0
      ? "| 重要度 | ファイル | 行 | タイトル | 内容 |\n|---|---|---:|---|---|\n" + rows.join("\n")
      : "指摘はありません。",
    "",
  ].join("\n");

  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    truncateText(summary, 900000),
    "utf8",
  );
}

function getDiscordColor(riskLevel) {
  const risk = String(riskLevel ?? "").toLowerCase();

  if (risk === "high") {
    return 15548997;
  }

  if (risk === "medium") {
    return 16776960;
  }

  return 5763719;
}

async function notifyDiscord(review, comments, mode, targetUrl, reviewAll) {
  if (!DISCORD_REVIEW_WEBHOOK_URL) {
    return;
  }

  const payload = {
    username: "AIコードレビュー",
    content: "DeepSeekによるコードレビューが完了しました。",
    embeds: [
      {
        title: mode === "pull_request"
          ? "Pull Requestレビュー"
          : "Pushレビュー",
        url: targetUrl,
        color: getDiscordColor(review.risk_level),
        description: truncateText(review.summary ?? "総評はありません。", 1800),
        fields: [
          {
            name: "リポジトリ",
            value: GITHUB_REPOSITORY,
            inline: true,
          },
          {
            name: "ブランチ",
            value: GITHUB_REF_NAME || "unknown",
            inline: true,
          },
          {
            name: "リスク",
            value: formatRiskLabel(review.risk_level),
            inline: true,
          },
          {
            name: "コメント数",
            value: String(comments.length),
            inline: true,
          },
          {
            name: "モデル",
            value: DEEPSEEK_MODEL,
            inline: true,
          },
          {
            name: "実行モード",
            value: reviewAll ? `${formatRunModeLabel(mode)} / リポジトリ全体` : `${formatRunModeLabel(mode)} / 差分`,
            inline: true,
          },
        ],
      },
    ],
  };

  try {
    const response = await fetch(DISCORD_REVIEW_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      console.warn(`Discord webhook failed: ${response.status}\n${text}`);
    }
  } catch (error) {
    console.warn("Discord webhook failed.");
    console.warn(error);
  }
}

async function runReview(mode, files, options = {}) {
  const reviewAll = Boolean(options.reviewAll);
  const targetFiles = files.filter(isReviewTargetFile);

  if (targetFiles.length === 0 && !reviewAll) {
    const review = {
      summary: "レビュー対象のテキスト差分がありませんでした。",
      risk_level: "low",
      comments: [],
    };

    let reviewResult = null;

    if (isPullRequest || isIssueComment) {
      reviewResult = await createPullRequestReview(review, [], [], false);
    }

    const targetUrl = getTargetUrl(reviewResult);
    writeStepSummary(review, [], mode, targetUrl, false);
    await notifyDiscord(review, [], mode, targetUrl, false);
    return;
  }

  const lineMapByPath = new Map();

  for (const file of targetFiles) {
    lineMapByPath.set(file.filename, buildLinePositionMap(file.patch));
  }

  const diffText = buildDiffForPrompt(targetFiles);
  const repositoryContext = reviewAll
    ? await buildRepositoryContextForPrompt()
    : { text: "", lineCountsByPath: new Map() };
  const review = await requestDeepSeekReview(diffText, {
    reviewAll,
    repositoryText: repositoryContext.text,
  });
  const inlineComments = filterValidComments(review.comments ?? [], lineMapByPath);
  const allComments = reviewAll
    ? filterRepositoryComments(review.comments ?? [], repositoryContext.lineCountsByPath)
    : inlineComments;

  let reviewResult = null;

  if (isPullRequest || isIssueComment) {
    reviewResult = await createPullRequestReview(review, inlineComments, allComments, reviewAll);
  } else {
    emitPushAnnotations(allComments);
  }

  const targetUrl = getTargetUrl(reviewResult);

  writeStepSummary(review, allComments, mode, targetUrl, reviewAll);
  await notifyDiscord(review, allComments, mode, targetUrl, reviewAll);

  console.log(`DeepSeek review completed. mode=${mode} scope=${reviewAll ? "repository" : "diff"} comments=${allComments.length} inline=${inlineComments.length}`);
}

async function main() {
  const reviewAll = await shouldReviewAllRepository();

  if (isPullRequest) {
    const files = await getPullRequestFiles();
    await runReview("pull_request", files, { reviewAll });
    return;
  }

  if (isPush) {
    if (SKIP_PUSH_REVIEW_IF_OPEN_PR === "true") {
      const hasOpenPr = await hasOpenPullRequestForCommit();

      if (hasOpenPr) {
        console.log("This push is already associated with an open PR. Skip push review to avoid duplicate DeepSeek review.");
        return;
      }
    }

    const files = await getPushFiles();
    await runReview("push", files, { reviewAll });
    return;
  }

  if (isIssueComment) {
    if (!reviewAll) {
      console.log("Issue/PR comment does not contain /all. Skip DeepSeek review.");
      return;
    }

    if (!eventPayload.issue?.pull_request) {
      console.log("Issue comment is not on a pull request. Skip DeepSeek review.");
      return;
    }

    const files = await getPullRequestFiles();
    await runReview("issue_comment", files, { reviewAll: true });
    return;
  }

  console.log(`Unsupported event: ${GITHUB_EVENT_NAME}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

import assert from "node:assert/strict";
import {
  collectGithubReplyTargets,
  extractGithubLinks,
  githubPreviewToDocument,
  parseGithubUrl,
  type GithubPagePreview,
} from "./githubPreviewSource.js";

function translationParts(document: ReturnType<typeof githubPreviewToDocument>): Array<[string, string]> {
  return document.blocks.flatMap((block) => block.type === "text"
    ? block.lines.flatMap((line) => line.parts.flatMap((part) => (
      part.translationKey ? [[part.text, part.translationKey] as [string, string]] : []
    )))
    : []);
}

assert.deepEqual(parseGithubUrl("https://www.github.com/octo/hello?tab=readme#readme"), {
  canonicalUrl: "https://github.com/octo/hello",
  kind: "repository",
  owner: "octo",
  repository: "hello",
});
assert.deepEqual(parseGithubUrl("github.com/octo/hello/issues/42?sort=created#comment-1"), {
  canonicalUrl: "https://github.com/octo/hello/issues/42",
  kind: "issue",
  owner: "octo",
  repository: "hello",
  number: 42,
});
assert.deepEqual(parseGithubUrl("https://github.com/octo/hello/pull/7/"), {
  canonicalUrl: "https://github.com/octo/hello/pull/7",
  kind: "pull",
  owner: "octo",
  repository: "hello",
  number: 7,
});
assert.deepEqual(parseGithubUrl("https://github.com/octo/hello/releases/tag/v1.2.3?draft=1"), {
  canonicalUrl: "https://github.com/octo/hello/releases/tag/v1.2.3",
  kind: "release",
  owner: "octo",
  repository: "hello",
  tag: "v1.2.3",
});
assert.deepEqual(parseGithubUrl("https://github.com/octo/hello/releases/latest"), {
  canonicalUrl: "https://github.com/octo/hello/releases/latest",
  kind: "release",
  owner: "octo",
  repository: "hello",
  tag: "latest",
});
assert.deepEqual(parseGithubUrl("https://github.com/octo/hello/releases/tag/latest"), {
  canonicalUrl: "https://github.com/octo/hello/releases/tag/latest",
  kind: "release",
  owner: "octo",
  repository: "hello",
  tag: "latest",
});
assert.deepEqual(parseGithubUrl("https://github.com/octo/hello/commit/0123456789abcdef0123456789abcdef01234567"), {
  canonicalUrl: "https://github.com/octo/hello/commit/0123456789abcdef0123456789abcdef01234567",
  kind: "commit",
  owner: "octo",
  repository: "hello",
  sha: "0123456789abcdef0123456789abcdef01234567",
});
assert.deepEqual(parseGithubUrl("https://github.com/octo/hello/blob/main/src%2Findex.ts?plain=1"), {
  canonicalUrl: "https://github.com/octo/hello/blob/main/src/index.ts",
  kind: "file",
  owner: "octo",
  repository: "hello",
  ref: "main",
  path: "src/index.ts",
});

for (const unsupported of [
  "https://gist.github.com/octo/123",
  "https://github.com/octo",
  "https://github.com/octo/hello/tree/main/src",
  "https://github.com/octo/hello/actions/runs/123",
  "https://github.com/octo/hello/search?q=test",
  "https://github.com.evil.example/octo/hello",
  "http://github.com/octo/hello",
  "https://github.com:444/octo/hello",
  "https://user:pass@github.com/octo/hello",
]) {
  assert.equal(parseGithubUrl(unsupported), null, unsupported);
}

assert.deepEqual(extractGithubLinks([
  "紹介 https://github.com/octo/hello.",
  "github.com/octo/hello/issues/42) ",
  "https://github.com.evil.example/octo/hello",
  "(https://github.com/octo/hello/pull/7)",
].join(" ")), [
  "https://github.com/octo/hello",
  "github.com/octo/hello/issues/42",
  "https://github.com/octo/hello/pull/7",
]);

const targets = collectGithubReplyTargets([
  "https://github.com/octo/hello?tab=readme",
  "https://github.com/octo/hello",
  "https://github.com/octo/hello/issues/1",
  "https://github.com/octo/hello/pull/2",
  "https://github.com/octo/hello/releases/tag/v1",
  "https://github.com/octo/hello/commit/0123456789abcdef0123456789abcdef01234567",
  "https://github.com/octo/hello/blob/main/a.ts",
]);
assert.equal(targets.length, 5);
assert.deepEqual(targets.map((target) => target.kind), ["repository", "issue", "pull", "release", "commit"]);
assert.equal(new Set(targets.map((target) => target.canonicalUrl)).size, 5);

const caseInsensitiveTargets = collectGithubReplyTargets([
  "https://github.com/OCTO/HELLO",
  "https://github.com/octo/hello?tab=readme",
]);
assert.equal(caseInsensitiveTargets.length, 1);

const repository: GithubPagePreview = {
  kind: "repository",
  canonicalUrl: "https://github.com/octo/hello",
  owner: "octo",
  repository: "hello",
  title: "octo/hello",
  description: "A useful project.",
  author: { name: "octo", avatarUrl: "https://avatars.githubusercontent.com/u/1" },
  stats: { stars: 12, forks: 3, openIssues: 1 },
  language: "TypeScript",
  defaultBranch: "main",
};
const repositoryDocument = githubPreviewToDocument(repository);
assert.equal(repositoryDocument.source, "github");
assert.deepEqual(translationParts(repositoryDocument), [["A useful project.", "description"]]);
assert.equal(repositoryDocument.blocks.some((block) => block.type === "text" && block.thumbnailUrl === "https://avatars.githubusercontent.com/u/1"), true);
assert.equal(JSON.stringify(repositoryDocument).includes("octo/hello"), true);

const issueDocument = githubPreviewToDocument({
  kind: "issue",
  canonicalUrl: "https://github.com/octo/hello/issues/42",
  owner: "octo",
  repository: "hello",
  title: "Fix the widget",
  description: "The widget is broken.",
  author: { name: "contributor", avatarUrl: "https://avatars.githubusercontent.com/u/2" },
  number: 42,
  state: "open",
  labels: ["bug"],
});
assert.deepEqual(translationParts(issueDocument), [["The widget is broken.", "body"]]);
assert.equal(JSON.stringify(issueDocument).includes("Fix the widget"), true);
assert.equal(JSON.stringify(issueDocument).includes('translationKey":"title'), false);

const pullDocument = githubPreviewToDocument({
  kind: "pull",
  canonicalUrl: "https://github.com/octo/hello/pull/7",
  owner: "octo",
  repository: "hello",
  title: "Improve the widget",
  description: "Pull request details.",
  author: { name: "contributor" },
  number: 7,
  state: "open",
  labels: ["enhancement"],
  stats: { additions: 5, deletions: 2, changedFiles: 1 },
});
assert.deepEqual(translationParts(pullDocument), [["Pull request details.", "body"]]);

const commitDocument = githubPreviewToDocument({
  kind: "commit",
  canonicalUrl: "https://github.com/octo/hello/commit/0123456789abcdef0123456789abcdef01234567",
  owner: "octo",
  repository: "hello",
  title: "Fix widget",
  message: "Fix widget\n\nCommit details.",
  sha: "0123456789abcdef0123456789abcdef01234567",
  author: { name: "octo" },
  stats: { additions: 2, deletions: 1, total: 3 },
});
assert.deepEqual(translationParts(commitDocument), []);

const releaseDocument = githubPreviewToDocument({
  kind: "release",
  canonicalUrl: "https://github.com/octo/hello/releases/tag/v1.2.3",
  owner: "octo",
  repository: "hello",
  title: "Hello v1.2.3",
  tag: "v1.2.3",
  description: "Release notes in English.",
  author: { name: "octo" },
  publishedAt: "2026-08-22T00:00:00Z",
});
assert.deepEqual(translationParts(releaseDocument), [["Release notes in English.", "body"]]);

const fileDocument = githubPreviewToDocument({
  kind: "file",
  canonicalUrl: "https://github.com/octo/hello/blob/main/src/index.ts",
  owner: "octo",
  repository: "hello",
  title: "src/index.ts",
  ref: "main",
  path: "src/index.ts",
  language: "TypeScript",
  code: `${"const value = 1;\n".repeat(300)}\n`,
});
assert.deepEqual(translationParts(fileDocument), []);
const fileText = JSON.stringify(fileDocument);
assert.equal(fileText.includes("translationKey"), false);
assert.equal(fileText.includes("const value = 1;"), true);
assert.equal(fileDocument.blocks.filter((block) => block.type === "text").length >= 2, true);

const unsafeAvatarDocument = githubPreviewToDocument({
  ...repository,
  author: { name: "octo", avatarUrl: "http://avatars.example.test/avatar.png" },
});
assert.equal(JSON.stringify(unsafeAvatarDocument).includes("avatars.example.test"), false);

console.log("githubPreviewSource.spec.ts: all assertions passed");

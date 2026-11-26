#!/usr/bin/env node
// モジュール境界チェッカー。
//
// import の抽出には devDependency の TypeScript compiler API を使い、それ以外は Node 標準機能で動く。
// 検出する違反 (メッセージ先頭の [名前] が規則名):
//   - [layer] 層の向き (最下層 / features / 入口層 / bot / index.ts)
//   - [allowlist] 機能間依存の許可リスト違反
//   - [allowlist-cycle] 許可リスト自身の循環
//   - [file-cycle] ファイル単位の循環 import (type-only import も含む)
//   - [max-lines] 行数超過 (テスト以外の .ts ファイルは 500 行以下)
//   - [resolve] src/ 内に解決できない相対 import
// 規則の説明は ARCHITECTURE.md の「チェック項目」を参照。
// 違反が 1 件でもあれば、内容を表示して終了コード 1 で終わる。

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_ROOT = resolve(import.meta.dirname, "..", "src");

// TypeScript はリポジトリの devDependency を使う。junction / symlink 経由で起動されても
// 実体パスから node_modules を解決できるよう realpath を通す。
const ts = createRequire(realpathSync(fileURLToPath(import.meta.url)))("typescript");

// 機能どうしの依存の許可リスト (正本)。ここにない向きは禁止。
// リスト自身が循環していないことも checkAllowlistAcyclic() で確かめる。
export const FEATURE_ALLOWLIST = Object.freeze({
  ai: ["panels", "japaneseAnalysis", "vc"],
  appeals: [],
  bokeru: ["ai", "bokete"],
  detecter: ["appeals"],
  gameDeals: ["epic", "steam"],
  linkPreviews: ["ai", "steam", "youtube"],
  moderation: ["panels"],
  modmail: ["appeals"],
  pacchi: ["ai", "japaneseAnalysis"],
  panelHub: ["ai", "messageLog", "moderation", "modmail", "panels", "reactionRoles", "reminders", "vc"],
  reactionRoles: ["panels"],
  reminders: ["panels"],
  senryu: ["ai", "japaneseAnalysis"],
  utilities: ["ai", "linkPreviews"],
  vc: ["panels", "messageLog"],
  youtube: [],
  youtubeWatcher: ["youtube", "linkPreviews"],
  panels: [],
});

// 層の定義
const BOTTOM_DIRS = ["core", "adapters", "vendor", "types"];
const ENTRY_DIRS = ["commands", "interactions", "message"];
const LINE_LIMIT = 500; // テスト以外の .ts ファイルの上限。分割で新しく作るファイルは 400 行を目安にする。

// ---------------------------------------------------------------------------
// import の抽出
// ---------------------------------------------------------------------------

// TypeScript の AST を歩いて、import / export ... from / 動的 import() /
// import x = require() / 型位置の import("...") を集める。文字列・コメント・正規表現・
// テンプレートリテラルは AST が区別するため、手書きの字句解析はしない。
// type-only import も依存辺として数える。
// 抽出結果: { spec: string, line: number (1 始まり), dynamic: boolean }
export function extractImportSpecifiers(source, fileName = "input.ts") {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found = [];
  const push = (node, spec, dynamic) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    found.push({ spec, line: line + 1, dynamic });
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      push(node, node.moduleSpecifier.text, false);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      push(node, node.moduleSpecifier.text, false);
    } else if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      push(node, node.moduleReference.expression.text, false);
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length > 0
      && ts.isStringLiteralLike(node.arguments[0])
    ) {
      push(node, node.arguments[0].text, true);
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteralLike(argument.literal)) {
        push(node, argument.literal.text, true);
      }
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return found;
}

// ---------------------------------------------------------------------------
// ファイル一覧と import グラフ
// ---------------------------------------------------------------------------

export function listSourceFiles(srcRoot = SRC_ROOT) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        files.push(full);
      }
    }
  };
  if (existsSync(srcRoot)) walk(srcRoot);
  return files.sort();
}

// 相対指定子を実際の .ts ファイルへ解決する (".js" → ".ts"、ディレクトリ → index.ts)。
// 解決できない場合は null (外部パッケージや解析不能な指定子)。
export function resolveSpecifier(fromFile, spec, srcRoot = SRC_ROOT) {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null;
  const base = dirname(fromFile);
  let candidate = resolve(base, spec);
  const candidates = [];
  if (candidate.endsWith(".js")) candidates.push(candidate.slice(0, -3) + ".ts");
  if (candidate.endsWith(".ts")) candidates.push(candidate);
  candidates.push(candidate + ".ts", join(candidate, "index.ts"));
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return toPosix(relative(srcRoot, c));
  }
  return null;
}

function toPosix(p) {
  return p.split(sep).join("/");
}

// src/ からの相対パスで層を分類する。
// 戻り値: { layer: "bottom"|"feature"|"entry"|"bot"|"top"|"testHelper", feature?: string }
export function classifyFile(relPath) {
  const parts = relPath.split("/");
  if (relPath === "index.ts" || relPath === "index.spec.ts") return { layer: "top" };
  if (parts[0] === "scripts") return { layer: "top" }; // tsx で直接実行する運用スクリプト (index.ts と同じ最上層扱い)
  if (parts[0] === "test") return { layer: "testHelper" };
  if (BOTTOM_DIRS.includes(parts[0])) return { layer: "bottom" };
  if (parts[0] === "features") {
    return { layer: "feature", feature: parts[1] ?? "" };
  }
  if (ENTRY_DIRS.includes(parts[0])) return { layer: "entry" };
  if (parts[0] === "bot") return { layer: "bot" };
  return { layer: "top" };
}

function isSpecFile(relPath) {
  return relPath.endsWith(".spec.ts");
}

// ひとつの import が規則に違反するなら、違反の説明を返す。そうでなければ null。
function checkEdge(fromRel, fromInfo, toRel, toInfo, _dynamic) {
  const specOnly = isSpecFile(fromRel);
  const from = fromInfo.layer;
  const to = toInfo.layer;
  const where = `${fromRel} -> ${toRel}`;

  // spec ファイルは src/test/ のテスト補助を import してよい。
  if (to === "testHelper") {
    if (specOnly) return null;
    return { rule: "layer", message: `${where}: テスト補助 (src/test/) を import できるのは spec ファイルだけ` };
  }

  switch (from) {
    case "bottom":
      if (to === "bottom") return null;
      return { rule: "layer", message: `${where}: 最下層 (core/adapters/vendor/types) は上の層 (${to}) を import できない` };
    case "feature": {
      if (to === "bottom") return null;
      if (to === "feature") {
        const fromFeature = fromInfo.feature;
        const toFeature = toInfo.feature;
        if (fromFeature === toFeature) return null; // 同じ機能の内部
        const allowed = FEATURE_ALLOWLIST[fromFeature] ?? [];
        if (allowed.includes(toFeature)) return null;
        return {
          rule: "allowlist",
          message: `${where}: 機能 ${fromFeature} から ${toFeature} への依存は許可リストにない`,
        };
      }
      return { rule: "layer", message: `${where}: 機能のコードは ${to} 層を import できない` };
    }
    case "entry":
      if (to === "bottom" || to === "feature" || to === "entry") return null;
      if (to === "bot") {
        if (toRel === "bot/context.ts") return null;
        return { rule: "layer", message: `${where}: 入口層が bot/ を import してよいのは bot/context.ts だけ` };
      }
      return { rule: "layer", message: `${where}: 入口層は ${to} 層を import できない` };
    case "testHelper":
      if (to === "bottom") return null;
      return { rule: "layer", message: `${where}: テスト補助 (src/test/) は最下層しか import できない` };
    case "bot":
    case "top":
      return null; // 最上層はすべてを知ってよい
    default:
      return { rule: "layer", message: `${where}: 不明な層 (${from})` };
  }
}

// ファイル単位の循環 import を Tarjan の SCC で見つける (type-only も含む)。
function findCycles(graph) {
  const nodes = [...graph.keys()].sort();
  const indexOf = new Map(nodes.map((n, i) => [n, i]));
  const adj = nodes.map((n) => [...(graph.get(n) ?? [])].filter((t) => indexOf.has(t)).sort());
  const UNVISITED = -1;
  const indices = nodes.map(() => UNVISITED);
  const low = nodes.map(() => 0);
  const onStack = nodes.map(() => false);
  const stack = [];
  const cycles = [];
  let counter = 0;

  const strongconnect = (v) => {
    indices[v] = counter;
    low[v] = counter;
    counter += 1;
    stack.push(v);
    onStack[v] = true;
    for (const w of adj[v]) {
      const wi = indexOf.get(w);
      if (indices[wi] === UNVISITED) {
        strongconnect(wi);
        low[v] = Math.min(low[v], low[wi]);
      } else if (onStack[wi]) {
        low[v] = Math.min(low[v], indices[wi]);
      }
    }
    if (low[v] === indices[v]) {
      const component = [];
      for (;;) {
        const w = stack.pop();
        onStack[w] = false;
        component.push(nodes[w]);
        if (w === v) break;
      }
      if (component.length > 1) cycles.push(component.sort());
      // 自己ループ (a.ts が自分自身を import) は不正なグラフなので無視
    }
  };

  for (let v = 0; v < nodes.length; v += 1) {
    if (indices[v] === UNVISITED) strongconnect(v);
  }
  return cycles;
}

// 許可リスト自身が DAG になっていることを確かめる。
export function checkAllowlistAcyclic(allowlist = FEATURE_ALLOWLIST) {
  const graph = new Map();
  for (const [feature, deps] of Object.entries(allowlist)) {
    graph.set(feature, deps.filter((d) => d !== feature));
  }
  const cycles = findCycles(graph);
  return cycles.map((c) => `[allowlist-cycle] 許可リスト自身が循環している: ${c.join(" -> ")}`);
}

// 末尾の改行は空の行として数えない (500 行 + 末尾改行は 500 行)。
function countLines(source) {
  if (source.length === 0) return 0;
  const newlineCount = source.match(/\r\n|\r|\n/g)?.length ?? 0;
  return newlineCount + (/(?:\r\n|\r|\n)$/.test(source) ? 0 : 1);
}

export function analyzeBoundaries(srcRoot = SRC_ROOT) {
  const violations = [];
  const graph = new Map(); // relPath -> Set<relPath>

  for (const file of listSourceFiles(srcRoot)) {
    const rel = toPosix(relative(srcRoot, file));
    const source = readFileSync(file, "utf8");
    const specifiers = extractImportSpecifiers(source, file);
    const fromInfo = classifyFile(rel);
    const edges = graph.get(rel) ?? new Set();
    graph.set(rel, edges);

    for (const { spec, line, dynamic } of specifiers) {
      const target = resolveSpecifier(file, spec, srcRoot);
      const displaySpec = dynamic ? `import("${spec}")` : spec;
      if (target === null) {
        if (spec.startsWith("./") || spec.startsWith("../")) {
          violations.push(`${rel}:${line}: [resolve] 相対 import "${displaySpec}" が src/ 内のファイルに解決できない`);
        }
        continue; // 外部パッケージ
      }
      edges.add(target);
      const toInfo = classifyFile(target);
      const problem = checkEdge(rel, fromInfo, target, toInfo, dynamic);
      if (problem) violations.push(`${rel}:${line}: [${problem.rule}] ${problem.message} ("${displaySpec}")`);
    }

    // テストファイル (*.spec.ts) は行数制限の対象外
    if (!isSpecFile(rel)) {
      const lines = countLines(source);
      if (lines > LINE_LIMIT) {
        violations.push(`[max-lines] ${rel}: ${lines} 行あり、上限 ${LINE_LIMIT} 行を超えている`);
      }
    }
  }

  for (const cycle of findCycles(graph)) {
    violations.push(`[file-cycle] 循環 import: ${cycle.join(" -> ")}`);
  }
  for (const problem of checkAllowlistAcyclic()) {
    violations.push(problem);
  }

  return violations;
}

function main() {
  const srcRoot = process.argv[2] ? resolve(process.argv[2]) : SRC_ROOT;
  const violations = analyzeBoundaries(srcRoot);
  if (violations.length === 0) {
    console.log("check-boundaries: no violations");
    console.log("ルールの説明: ARCHITECTURE.md の「チェック項目」");
    return;
  }
  console.error(`check-boundaries: ${violations.length} violation(s)`);
  for (const v of violations) console.error(`  - ${v}`);
  console.error("ルールの説明: ARCHITECTURE.md の「チェック項目」");
  process.exitCode = 1;
}

// junction / symlink 経由で起動されると import.meta.url と process.argv[1] の文字列は
// 一致しない。実体パス同士を比べて、CLI として起動されたときだけ main() を走らせる。
function invokedAsCli() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (invokedAsCli()) {
  main();
}

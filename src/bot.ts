import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (process.platform === "win32") {
  try {
    execSync("cmd /c chcp 65001>nul", { stdio: "ignore", windowsHide: true });
  } catch {
    /* ignore */
  }
}

function resolveDistIndexPath(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const fromSrcTree = join(here, "..", "dist", "index.js");
  if (existsSync(fromSrcTree)) {
    return fromSrcTree;
  }
  const sibling = join(here, "index.js");
  if (existsSync(sibling)) {
    return sibling;
  }
  return undefined;
}

const entryPath = resolveDistIndexPath();

if (!entryPath) {
  console.error(
    "dist/index.js がありません。次のいずれかを実行してください:\n" +
      "  npm run build        # ビルド後に npm start / node dist/bot.js\n" +
      "  npm run dev          # 開発用（tsx watch）\n" +
      "  npx tsx src/bot.ts   # ビルド済み dist がある状態でランチャのみ TS 実行",
  );
  process.exit(1);
}

await import(pathToFileURL(entryPath).href);

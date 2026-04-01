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
  const siblingJs = join(here, "index.js");
  if (existsSync(siblingJs)) {
    return siblingJs;
  }
  const siblingTs = join(here, "index.ts");
  if (existsSync(siblingTs)) {
    return siblingTs;
  }
  return undefined;
}

const entryPath = resolveDistIndexPath();

if (!entryPath) {
  console.error(
    "index のエントリが見つかりません（dist/index.js または src/index.ts）。次を試してください:\n" +
      "  npm run build        # ビルド後に node bot.ts / npm start\n" +
      "  node bot.ts          # 未ビルドなら tsx で src から起動\n" +
      "  npm run dev          # 開発用（tsx watch src/index.ts）",
  );
  process.exit(1);
}

await import(pathToFileURL(entryPath).href);

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const distBot = join(root, "dist", "bot.js");

if (existsSync(distBot)) {
  await import(pathToFileURL(distBot).href);
} else {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, ["--import", "tsx", join(root, "src", "bot.ts")], {
    stdio: "inherit",
    cwd: root,
    env: process.env,
  });
  process.exit(r.status ?? 1);
}

import { spawnSync } from "node:child_process";

// Cross-platform replacement for `set BOT_PROFILE=debug&& ...` (cmd.exe only).
const env = { ...process.env, BOT_PROFILE: "debug" };

if (process.argv.includes("--utf8") && process.platform === "win32") {
  spawnSync("chcp", ["65001"], { stdio: "ignore", shell: true });
}

function node(args) {
  return spawnSync(process.execPath, ["--env-file-if-exists=.env", "--import", "tsx", ...args], { env, stdio: "inherit" });
}

const spec = node(["src/features/senryu/senryu.spec.ts"]);
if (spec.status !== 0) process.exit(spec.status ?? 1);

const bot = node(["--watch", "src/index.ts"]);
process.exit(bot.status ?? 0);

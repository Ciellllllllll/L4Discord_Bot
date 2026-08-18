import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { AppConfig } from "../../core/config.js";

type WorkerProcessLog = {
  debug?: (obj: Record<string, unknown>, message: string) => void;
  info: (obj: Record<string, unknown>, message: string) => void;
  warn: (obj: Record<string, unknown>, message: string) => void;
  error: (obj: Record<string, unknown>, message: string) => void;
};

export type JapaneseWorkerController = {
  started: boolean;
  stop: () => Promise<void>;
};

function findRepoRoot(fromFile: string): string {
  let dir = dirname(fromFile);
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return dirname(fromFile);
    dir = parent;
  }
}

function resolveWorkerAddr(workerUrl: string): string {
  const url = new URL(workerUrl);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return `${url.hostname}:${port}`;
}

async function isWorkerHealthy(workerUrl: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(new URL("/health", workerUrl), {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const body = await response.json() as { ok?: unknown };
    return body.ok === true;
  } catch {
    return false;
  }
}

function resolveWorkerCommand(repoRoot: string): {
  command: string;
  args: string[];
  cwd: string;
} {
  const workerDir = join(repoRoot, "workers", "japanese-worker");
  const windowsBinary = join(workerDir, "japanese-worker.exe");
  if (process.platform === "win32" && existsSync(windowsBinary)) {
    return { command: windowsBinary, args: [], cwd: workerDir };
  }

  const unixBinary = join(workerDir, "japanese-worker");
  if (process.platform !== "win32" && existsSync(unixBinary)) {
    return { command: unixBinary, args: [], cwd: workerDir };
  }

  return { command: "go", args: ["run", "."], cwd: workerDir };
}

function stopChildProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }

    const done = () => {
      clearTimeout(forceTimer);
      resolve();
    };
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 5_000);

    child.once("exit", done);
    child.kill("SIGTERM");
  });
}

export async function startJapaneseWorkerIfEnabled(
  config: AppConfig,
  log: WorkerProcessLog,
): Promise<JapaneseWorkerController> {
  if (!config.JAPANESE_WORKER_ENABLED) {
    return { started: false, stop: async () => undefined };
  }

  const healthTimeoutMs = Math.min(config.JAPANESE_WORKER_TIMEOUT_MS, 2_000);
  if (await isWorkerHealthy(config.JAPANESE_WORKER_URL, healthTimeoutMs)) {
    log.debug?.(
      { workerUrl: config.JAPANESE_WORKER_URL },
      "japanese worker already healthy; bot will not manage external worker process",
    );
    return { started: false, stop: async () => undefined };
  }

  const repoRoot = findRepoRoot(fileURLToPath(import.meta.url));
  const { command, args, cwd } = resolveWorkerCommand(repoRoot);
  const workerAddr = resolveWorkerAddr(config.JAPANESE_WORKER_URL);
  const env = {
    ...process.env,
    JAPANESE_WORKER_ADDR: workerAddr,
  };

  log.debug?.({ command, args, cwd, workerAddr }, "starting japanese worker process");
  const child = spawn(command, args, {
    cwd: isAbsolute(cwd) ? cwd : join(repoRoot, cwd),
    env,
    windowsHide: true,
  });

  child.stdout.on("data", (chunk: Buffer) => {
    log.info({ line: chunk.toString("utf8").trimEnd() }, "japanese worker stdout");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    log.warn({ line: chunk.toString("utf8").trimEnd() }, "japanese worker stderr");
  });
  child.on("error", (err) => {
    log.error({ err }, "japanese worker process error");
  });
  child.on("exit", (code, signal) => {
    log.warn({ code, signal }, "japanese worker process exited");
  });

  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Japanese worker exited before becoming healthy (code=${child.exitCode}, signal=${child.signalCode})`);
    }
    if (await isWorkerHealthy(config.JAPANESE_WORKER_URL, healthTimeoutMs)) {
      log.debug?.({ workerUrl: config.JAPANESE_WORKER_URL }, "japanese worker process is healthy");
      return {
        started: true,
        stop: async () => {
          log.info({ workerUrl: config.JAPANESE_WORKER_URL }, "stopping japanese worker process");
          await stopChildProcess(child);
        },
      };
    }
    await delay(500);
  }

  await stopChildProcess(child);
  throw new Error("Japanese worker did not become healthy within startup timeout");
}

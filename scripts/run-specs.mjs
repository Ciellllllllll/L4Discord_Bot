import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const specRoot = resolve(process.env.SPEC_ROOT ?? join(root, "src"));
const specTimeoutMs = Number(process.env.SPEC_TIMEOUT_MS ?? 120_000);
const forceKillGraceMs = Number(process.env.SPEC_FORCE_KILL_GRACE_MS ?? 5_000);

async function collectSpecs(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectSpecs(path);
    return entry.isFile() && entry.name.endsWith(".spec.ts") ? [path] : [];
  }));
  return files.flat();
}

function runSpec(spec) {
  return new Promise((resolve) => {
    let timedOut = false;
    let forceKillTimer;
    const child = spawn(process.execPath, ["--import", "tsx", spec], {
      cwd: root,
      stdio: "inherit",
      shell: false,
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), forceKillGraceMs);
    }, specTimeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({ spec, code: code ?? 1, signal, timedOut });
    });
    child.once("error", () => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({ spec, code: 1, signal: null, timedOut });
    });
  });
}

const specs = (await collectSpecs(specRoot)).sort();
const failures = [];
for (const spec of specs) {
  console.log(`RUN ${relative(root, spec)}`);
  const result = await runSpec(spec);
  if (result.code !== 0 || result.timedOut) failures.push(result);
}

if (failures.length > 0) {
  console.error("Failed specs:");
  for (const failure of failures) {
    const detail = failure.timedOut ? `timeout ${specTimeoutMs}ms` : `exit ${failure.code}`;
    console.error(`${relative(root, failure.spec)} (${detail})`);
  }
  process.exitCode = 1;
} else {
  console.log(`All ${specs.length} spec files passed.`);
}

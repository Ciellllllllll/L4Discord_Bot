import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

async function run(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "l4-run-specs-"));
  try {
    await writeFile(join(dir, "a-hang.spec.ts"), "setInterval(() => undefined, 1000);\n", "utf8");
    await writeFile(join(dir, "b-pass.spec.ts"), 'process.stdout.write("PASS_AFTER_TIMEOUT\\n");\n', "utf8");
    const child = spawn(process.execPath, ["scripts/run-specs.mjs"], {
      cwd: process.cwd(),
      env: { ...process.env, SPEC_ROOT: dir, SPEC_TIMEOUT_MS: "1000", SPEC_FORCE_KILL_GRACE_MS: "100" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode) => resolve(exitCode ?? 1));
    });
    assert.equal(code, 1);
    assert.match(stdout, /PASS_AFTER_TIMEOUT/);
    assert.match(stderr, /a-hang\.spec\.ts \(timeout 1000ms\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

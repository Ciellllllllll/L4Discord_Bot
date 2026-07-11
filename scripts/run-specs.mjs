import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();

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
    const child = spawn(process.execPath, ["--import", "tsx", spec], {
      cwd: root,
      stdio: "inherit",
      shell: false,
    });
    child.once("exit", (code, signal) => resolve({ spec, code: code ?? 1, signal }));
    child.once("error", () => resolve({ spec, code: 1, signal: null }));
  });
}

const specs = (await collectSpecs(join(root, "src"))).sort();
const failures = [];
for (const spec of specs) {
  console.log(`RUN ${relative(root, spec)}`);
  const result = await runSpec(spec);
  if (result.code !== 0) failures.push(result);
}

if (failures.length > 0) {
  console.error("Failed specs:");
  for (const failure of failures) console.error(`${relative(root, failure.spec)} (exit ${failure.code})`);
  process.exitCode = 1;
} else {
  console.log(`All ${specs.length} spec files passed.`);
}

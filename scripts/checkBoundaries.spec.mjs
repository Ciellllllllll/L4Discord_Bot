import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { analyzeBoundaries, checkAllowlistAcyclic } from "./check-boundaries.mjs";

// check-boundaries.mjs の検出規則を、小さな仮のファイル構成で確かめる。

const base = await mkdtemp(join(tmpdir(), "check-boundaries-spec-"));

after(async () => {
  await rm(base, { recursive: true, force: true });
});

async function makeTree(name, files) {
  const root = join(base, name);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return root;
}

function violationsFor(root) {
  return analyzeBoundaries(root);
}

function assertViolation(root, pattern) {
  const violations = violationsFor(root);
  assert.equal(
    violations.some((violation) => pattern.test(violation)),
    true,
    `expected ${pattern} in:\n${violations.join("\n")}`,
  );
}

test("clean fixture tree passes", async () => {
  const root = await makeTree("clean", {
    "core/util.ts": "export const util = 1;\n",
    "features/panels/panel.ts": "import { util } from \"../../core/util.js\";\nexport const panel = util;\n",
    "features/ai/ai.ts": "import { panel } from \"../panels/panel.js\";\nexport const ai = panel;\n",
    "commands/command.ts": "import { ai } from \"../features/ai/ai.js\";\nexport const command = ai;\n",
  });
  assert.deepEqual(violationsFor(root), []);
});

test("layer rule is detected", async () => {
  const root = await makeTree("layer", {
    "features/panels/panel.ts": "export const panel = 1;\n",
    "core/bad.ts": "import { panel } from \"../features/panels/panel.js\";\nexport const bad = panel;\n",
  });
  assertViolation(root, /core\/bad\.ts.*features\/panels\/panel\.ts.*最下層/u);
});

test("feature allowlist rule is detected", async () => {
  const root = await makeTree("allowlist", {
    "features/bokete/bokete.ts": "export const bokete = 1;\n",
    "features/ai/bad.ts": "import { bokete } from \"../bokete/bokete.js\";\nexport const bad = bokete;\n",
  });
  assertViolation(root, /features\/ai\/bad\.ts.*features\/bokete\/bokete\.ts.*許可リスト/u);
});

test("allowlist cycle is detected", () => {
  const violations = checkAllowlistAcyclic({ a: ["b"], b: ["a"] });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /許可リスト.*循環/u);
});

test("file-level import cycle is detected", async () => {
  const root = await makeTree("cycle", {
    "features/panels/a.ts": "import { b } from \"./b.js\";\nexport const a = b;\n",
    "features/panels/b.ts": "import { a } from \"./a.js\";\nexport const b = a;\n",
  });
  assertViolation(root, /循環 import.*features\/panels\/a\.ts.*features\/panels\/b\.ts/u);
});

test("line limit is detected for non-spec files only", async () => {
  const root = await makeTree("lines", {
    "features/panels/long.ts": `${Array.from({ length: 501 }, (_, index) => `const line${index} = ${index};`).join("\n")}\n`,
    "features/panels/long.spec.ts": `${Array.from({ length: 501 }, (_, index) => `const specLine${index} = ${index};`).join("\n")}\n`,
  });
  const violations = violationsFor(root);
  assert.equal(violations.filter((violation) => /500 行/u.test(violation)).length, 1);
  assert.match(violations.join("\n"), /features\/panels\/long\.ts: 501 行/u);
});

test("exactly 500 lines with a trailing newline passes; 501 lines fails", async () => {
  const root = await makeTree("line-boundary", {
    "features/panels/exact.ts": `${Array.from({ length: 500 }, (_, index) => `const exact${index} = ${index};`).join("\n")}\n`,
    "features/panels/over.ts": `${Array.from({ length: 501 }, (_, index) => `const over${index} = ${index};`).join("\n")}\n`,
  });
  const violations = violationsFor(root);
  assert.equal(
    violations.some((violation) => /features\/panels\/exact\.ts/u.test(violation)),
    false,
    violations.join("\n"),
  );
  assert.match(violations.join("\n"), /features\/panels\/over\.ts: 501 行/u);
});

test("a regex literal containing a quote does not hide a later dynamic import", async () => {
  const root = await makeTree("regex-literal", {
    "features/bokete/bokete.ts": "export const bokete = 1;\n",
    "features/ai/bad.ts": [
      "const re = /'/g;",
      "export async function load(): Promise<unknown> { return import(\"../bokete/bokete.js\"); }",
      "",
    ].join("\n"),
  });
  assertViolation(root, /features\/ai\/bad\.ts:2:.*features\/bokete\/bokete\.ts.*許可リスト/u);
});

test("a template literal with a backslash-newline keeps later import line numbers", async () => {
  const root = await makeTree("template-newline", {
    "features/bokete/bokete.ts": "export const bokete = 1;\n",
    "features/ai/bad.ts": "const text = `first\\\nsecond`;\nimport { bokete } from \"../bokete/bokete.js\";\nexport const bad = bokete;\n",
  });
  assertViolation(root, /features\/ai\/bad\.ts:3:.*features\/bokete\/bokete\.ts.*許可リスト/u);
});

test("import-like text inside strings and comments is ignored", async () => {
  const root = await makeTree("fake-imports", {
    "features/bokete/bokete.ts": "export const bokete = 1;\n",
    "features/ai/ok.ts": [
      "const s = 'import { x } from \"../bokete/bokete.js\"';",
      '// import { y } from "../bokete/bokete.js";',
      '/* import("../bokete/bokete.js") */',
      "export const ok = s;",
      "",
    ].join("\n"),
  });
  assert.deepEqual(violationsFor(root), []);
});

test("check-boundaries.mjs exits 0 for a clean tree and 1 for a violating tree", async () => {
  const script = resolve(import.meta.dirname, "check-boundaries.mjs");
  const cleanRoot = await makeTree("exit-clean", {
    "features/panels/panel.ts": "export const panel = 1;\n",
  });
  const clean = spawnSync(process.execPath, [script, cleanRoot], { encoding: "utf8" });
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /no violations/u);
  assert.match(clean.stdout, /ARCHITECTURE\.md/u);

  const badRoot = await makeTree("exit-bad", {
    "features/panels/long.ts": `${Array.from({ length: 501 }, (_, index) => `const line${index} = ${index};`).join("\n")}\n`,
  });
  const bad = spawnSync(process.execPath, [script, badRoot], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /violation/u);
  assert.match(bad.stderr, /max-lines/u);
  assert.match(bad.stderr, /ARCHITECTURE\.md/u);
});

test("check-boundaries.mjs still runs when invoked through a junction/symlinked directory", async () => {
  const linkedScripts = join(base, "linked-scripts");
  await symlink(resolve(import.meta.dirname), linkedScripts, process.platform === "win32" ? "junction" : "dir");
  try {
    const badRoot = await makeTree("junction-bad", {
      "features/panels/long.ts": `${Array.from({ length: 501 }, (_, index) => `const line${index} = ${index};`).join("\n")}\n`,
    });
    const linkedScript = join(linkedScripts, "check-boundaries.mjs");
    const result = spawnSync(process.execPath, [linkedScript, badRoot], { encoding: "utf8" });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /violation/u);
    assert.match(result.stderr, /max-lines/u);
  } finally {
    await rm(linkedScripts, { recursive: true, force: true });
  }
});

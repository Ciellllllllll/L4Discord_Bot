import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { execFileSync } from "node:child_process";
import ts from "typescript";

const repoRoot = process.cwd();
const sourceFiles = execFileSync("git", ["ls-files", "src/**/*.ts"], {
  cwd: repoRoot,
  encoding: "utf8",
})
  .split(/\r?\n/)
  .filter((file) => file && existsSync(file) && !file.endsWith(".spec.ts"));

const offenders: string[] = [];

function propertyName(prop: ts.ObjectLiteralElementLike): string | null {
  if (!ts.isPropertyAssignment(prop) || !prop.name) return null;
  if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) || ts.isNumericLiteral(prop.name)) {
    return prop.name.text;
  }
  return null;
}

function isComponentCardsSpread(prop: ts.ObjectLiteralElementLike): boolean {
  return ts.isSpreadAssignment(prop)
    && ts.isCallExpression(prop.expression)
    && ts.isIdentifier(prop.expression.expression)
    && prop.expression.expression.text === "componentCardsPayload";
}

function isPayloadProducingSpread(prop: ts.ObjectLiteralElementLike, sourceFile: ts.SourceFile): boolean {
  if (!ts.isSpreadAssignment(prop)) return false;
  const text = prop.expression.getText(sourceFile);
  return /\bpayload\b/.test(text)
    || /\bbuild[A-Za-z0-9_]*Payload\(/.test(text)
    || /\bbuildAnonymousSurveyMessage\(/.test(text);
}

function includesMessageFlag(expression: ts.Expression, flagName: string, sourceFile: ts.SourceFile): boolean {
  return expression.getText(sourceFile).includes(`MessageFlags.${flagName}`);
}

for (const file of sourceFiles) {
  const text = readFileSync(file, "utf8");
  if (/\bEmbedBuilder\b/.test(text)) {
    offenders.push(`${relative(repoRoot, file)} uses EmbedBuilder`);
  }
  if (/embeds\s*:\s*(?:\[(?!\s*\])|[A-Za-z_])/s.test(text)) {
    offenders.push(`${relative(repoRoot, file)} sends non-empty embeds`);
  }
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node) && node.properties.some(isComponentCardsSpread)) {
      for (const prop of node.properties) {
        const name = propertyName(prop);
        if (name === "content") {
          offenders.push(`${relative(repoRoot, file)} mixes content with Components V2 payload`);
        }
        if (name === "components") {
          offenders.push(`${relative(repoRoot, file)} overwrites Components V2 components`);
        }
        if (
          name === "flags"
          && ts.isPropertyAssignment(prop)
          && includesMessageFlag(prop.initializer, "Ephemeral", sourceFile)
          && !includesMessageFlag(prop.initializer, "IsComponentsV2", sourceFile)
        ) {
          offenders.push(`${relative(repoRoot, file)} overwrites Components V2 flags with Ephemeral`);
        }
      }
    }
    if (ts.isObjectLiteralExpression(node) && node.properties.some((prop) => isPayloadProducingSpread(prop, sourceFile))) {
      for (const prop of node.properties) {
        const name = propertyName(prop);
        if (
          name === "flags"
          && ts.isPropertyAssignment(prop)
          && includesMessageFlag(prop.initializer, "Ephemeral", sourceFile)
          && !includesMessageFlag(prop.initializer, "IsComponentsV2", sourceFile)
        ) {
          offenders.push(`${relative(repoRoot, file)} may overwrite Components V2 flags from a payload spread`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (/embeds\??\s*:\s*ComponentCardBuilder\[\]/.test(text)) {
    offenders.push(`${relative(repoRoot, file)} names ComponentCardBuilder results as embeds`);
  }
}

assert.deepEqual(offenders, []);

console.log("componentsV2Only.spec.ts: no internal Embed payloads found");

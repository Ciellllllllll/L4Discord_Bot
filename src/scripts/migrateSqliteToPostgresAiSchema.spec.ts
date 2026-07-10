import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("./migrateSqliteToPostgres.ts", import.meta.url)), "utf8");
const canonicalEnsure = source.indexOf("await ensurePostgresAiProviderSchema(pool, config.POSTGRES_MAIN_SCHEMA)");
const genericLoop = source.indexOf("for (const source of sources)");

assert.ok(canonicalEnsure >= 0, "AI provider tables must use the canonical PostgreSQL schema");
assert.ok(genericLoop >= 0 && canonicalEnsure < genericLoop, "canonical AI schema must be ensured before generic SQLite table copy");

console.log("migrateSqliteToPostgresAiSchema.spec.ts: all assertions passed");

import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPostgresMigrations } from "./postgresMigrations.js";

function fakePool(options: { failApply?: boolean } = {}) {
  const queries: string[] = [];
  const client = {
    query: async (sql: string) => {
      const normalized = sql.trim().replace(/\s+/g, " ");
      queries.push(normalized);
      if (normalized.startsWith("SELECT 1 FROM postgres_schema_migrations")) return { rowCount: 0 };
      if (options.failApply && normalized === "MIGRATION DDL") throw new Error("DDL failed");
      return { rowCount: 1 };
    },
    release: () => undefined,
  };
  return { pool: { connect: async () => client } as never, queries };
}

test("PostgreSQL migration commits DDL and history in one transaction", async () => {
  const fixture = fakePool();
  await applyPostgresMigrations(fixture.pool, [{ version: 1, name: "test", apply: async (db) => { await db.query("MIGRATION DDL"); } }]);
  const begin = fixture.queries.indexOf("BEGIN");
  const ddl = fixture.queries.indexOf("MIGRATION DDL");
  const history = fixture.queries.findIndex((sql) => sql.startsWith("INSERT INTO postgres_schema_migrations"));
  const commit = fixture.queries.indexOf("COMMIT");
  assert.equal(begin < ddl && ddl < history && history < commit, true);
});

test("PostgreSQL migration rolls back failed DDL without recording history", async () => {
  const fixture = fakePool({ failApply: true });
  await assert.rejects(
    applyPostgresMigrations(fixture.pool, [{ version: 1, name: "test", apply: async (db) => { await db.query("MIGRATION DDL"); } }]),
    /DDL failed/,
  );
  assert.equal(fixture.queries.includes("ROLLBACK"), true);
  assert.equal(fixture.queries.some((sql) => sql.startsWith("INSERT INTO postgres_schema_migrations")), false);
});

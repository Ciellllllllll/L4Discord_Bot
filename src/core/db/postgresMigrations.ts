import type { Pool } from "pg";
import type { PgQueryable } from "./postgres.js";

export type PostgresMigration = {
  version: number;
  name: string;
  apply: (pool: PgQueryable) => Promise<void>;
};

export async function applyPostgresMigrations(pool: Pool, migrations: PostgresMigration[]): Promise<void> {
  const client = await pool.connect();
  let locked = false;
  let migrationError: unknown = null;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext(current_schema() || ':postgres_schema_migrations'))");
    locked = true;

    await client.query(`
      CREATE TABLE IF NOT EXISTS postgres_schema_migrations (
        version integer PRIMARY KEY,
        name text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
      const existing = await client.query("SELECT 1 FROM postgres_schema_migrations WHERE version = $1", [migration.version]);
      if ((existing.rowCount ?? 0) > 0) continue;
      await migration.apply(client);
      await client.query(
        "INSERT INTO postgres_schema_migrations (version, name) VALUES ($1, $2)",
        [migration.version, migration.name],
      );
    }
  } catch (error) {
    migrationError = error;
    throw error;
  } finally {
    try {
      if (locked) {
        await client.query("SELECT pg_advisory_unlock(hashtext(current_schema() || ':postgres_schema_migrations'))");
      }
    } catch (unlockError) {
      if (!migrationError) throw unlockError;
    } finally {
      client.release();
    }
  }
}

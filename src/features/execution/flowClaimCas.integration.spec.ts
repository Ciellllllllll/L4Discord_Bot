import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { Pool } from "pg";
import { getOptionalPostgresTestUrl } from "../../test/postgresTestEnv.js";

const rawState = JSON.stringify({ phase: "admin_pending", admin_button_fired: false });
const claimedState = JSON.stringify({ phase: "admin_pending", admin_button_fired: true });

{
  const db = new Database(":memory:");
  db.exec("CREATE TABLE polls (id TEXT PRIMARY KEY, status TEXT NOT NULL, state TEXT NOT NULL, state_revision INTEGER NOT NULL DEFAULT 0)");
  db.prepare("INSERT INTO polls (id, status, state) VALUES (?, ?, ?)").run("flow", "open", rawState);
  const claim = db.prepare("UPDATE polls SET state = ?, state_revision = state_revision + 1 WHERE id = ? AND status = ? AND state = ? AND state_revision = ?");
  assert.equal(claim.run(claimedState, "flow", "open", rawState, 0).changes, 1);
  assert.equal(claim.run(claimedState, "flow", "open", rawState, 0).changes, 0);
  db.close();
}

const connectionString = getOptionalPostgresTestUrl("TEST_DATABASE_URL", "flowClaimCas.integration.spec.ts");
if (connectionString) {
  const pool = new Pool({ connectionString });
  const table = `flow_claim_cas_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  try {
    await pool.query(`CREATE TABLE "${table}" (id text PRIMARY KEY, status text NOT NULL, state jsonb NOT NULL, state_revision integer NOT NULL DEFAULT 0)`);
    await pool.query(`INSERT INTO "${table}" (id, status, state) VALUES ($1, $2, $3::jsonb)`, ["flow", "open", rawState]);
    const sql = `UPDATE "${table}" SET state = $1::jsonb, state_revision = state_revision + 1 WHERE id = $2 AND status = $3 AND state = $4::jsonb AND state_revision = $5`;
    const [first, stale] = await Promise.all([
      pool.query(sql, [claimedState, "flow", "open", rawState, 0]),
      pool.query(sql, [claimedState, "flow", "open", rawState, 0]),
    ]);
    assert.equal([first.rowCount, stale.rowCount].filter((count) => count === 1).length, 1);
  } finally {
    await pool.query(`DROP TABLE IF EXISTS "${table}"`);
    await pool.end();
  }
}

console.log("flowClaimCas.integration.spec.ts: all assertions passed");

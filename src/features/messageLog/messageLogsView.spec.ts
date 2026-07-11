import assert from "node:assert/strict";
import { createPgPool, quotePgIdent } from "../../core/db/postgres.js";
import { ensurePostgresMessageLogsSchema } from "./messageLogsSchema.js";
import { prepareMessageAttachmentStorePostgres } from "./messageAttachmentArchive.js";
import { exportMessageLogsPostgres, searchMessageLogsPostgres, type SearchSession } from "./messageLogsView.js";
import { getOptionalPostgresTestUrl } from "../../test/postgresTestEnv.js";

async function run(): Promise<void> {
  const connectionString = getOptionalPostgresTestUrl("TEST_DATABASE_URL", "messageLogsView.spec.ts");
  if (!connectionString) return;
  const logSchema = `message_log_view_spec_${process.pid}_${Date.now()}`;
  const attachmentSchema = `${logSchema}_attachments`;
  const pool = await createPgPool(connectionString, logSchema);
  const attachmentPool = await createPgPool(connectionString, attachmentSchema);
  try {
    await ensurePostgresMessageLogsSchema(pool);
    await prepareMessageAttachmentStorePostgres(attachmentPool);
    await pool.query(
      `INSERT INTO message_logs
       (log_type, guild_id, channel_id, user_id, user_name, content, attachments, attachments_json, time, message_id, author_id, author_tag, author_display_name, created_at, embeds_json, reply_ref_json, attachment_count)
       VALUES ('normal', $1, $2, $3, 'user#1', 'PostgreSQLのログ', '[]', '[]', $4, $5, $3, 'user#1', '表示名', $4, '[]', NULL, 0)`,
      ["123456789012345678", "223456789012345678", "323456789012345678", "2026-07-11T00:00:00.000Z", "423456789012345678"],
    );
    const session: SearchSession = {
      id: "spec",
      ownerId: "999999999999999999",
      guildId: "123456789012345678",
      keyword: "PostgreSQL",
      userId: null,
      channelId: null,
      fromIso: null,
      toIso: null,
      attachmentsOnly: false,
      page: 0,
      createdAt: Date.now(),
      lastTouchedAt: Date.now(),
    };
    const page = await searchMessageLogsPostgres(pool, session, "999999999999999999");
    assert.equal(page.total, 1);
    assert.equal(page.rows[0]?.message_id, "423456789012345678");
    const exported = await exportMessageLogsPostgres(pool, attachmentPool, session, "999999999999999999", 50);
    assert.equal(exported.total, 1);
    assert.match(exported.content, /PostgreSQLのログ/);
    assert.match(exported.content, /423456789012345678/);
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${quotePgIdent(logSchema)} CASCADE`);
    await attachmentPool.query(`DROP SCHEMA IF EXISTS ${quotePgIdent(attachmentSchema)} CASCADE`);
    await pool.end();
    await attachmentPool.end();
  }
}

void run()
  .then(() => console.log("messageLogsView.spec.ts: all available assertions passed"))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

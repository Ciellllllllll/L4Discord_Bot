import type { Pool } from "pg";
import type { PgQueryable } from "../../core/db/postgres.js";
import { ulid } from "ulid";
import type { SenryuRecord, SavedSenryuRecord } from "./senryu.types.js";

export type SenryuRepository = {
  saveSenryu(record: SenryuRecord): Promise<SavedSenryuRecord>;
  deleteSenryu(id: string): Promise<void>;
};

export async function ensurePostgresSenryuSchema(pool: PgQueryable): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS senryu_records (
      id text PRIMARY KEY,
      guild_id text NOT NULL,
      channel_id text NOT NULL,
      message_id text NOT NULL,
      author_id text NOT NULL,
      kamigo text NOT NULL,
      nakashichi text NOT NULL,
      shimogo text NOT NULL,
      formatted text NOT NULL,
      source_content text NOT NULL,
      spoiler boolean NOT NULL,
      detected_at text NOT NULL
    );
    CREATE INDEX IF NOT EXISTS senryu_records_guild_idx ON senryu_records (guild_id);
    CREATE INDEX IF NOT EXISTS senryu_records_message_idx ON senryu_records (message_id);
    CREATE INDEX IF NOT EXISTS senryu_records_author_idx ON senryu_records (author_id);
    CREATE INDEX IF NOT EXISTS senryu_records_detected_idx ON senryu_records (detected_at);
  `);
}
export function createPostgresSenryuRepository(pool: Pool): SenryuRepository {
  return {
    async saveSenryu(record): Promise<SavedSenryuRecord> {
      const id = record.id ?? ulid();
      await pool.query(
        `INSERT INTO senryu_records (id, guild_id, channel_id, message_id, author_id, kamigo, nakashichi, shimogo, formatted, source_content, spoiler, detected_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [id, record.guildId, record.channelId, record.messageId, record.authorId, record.kamigo, record.nakashichi, record.shimogo, record.formatted, record.sourceContent, record.spoiler, record.detectedAt],
      );
      return { ...record, id };
    },
    async deleteSenryu(id): Promise<void> {
      await pool.query("DELETE FROM senryu_records WHERE id = $1", [id]);
    },
  };
}

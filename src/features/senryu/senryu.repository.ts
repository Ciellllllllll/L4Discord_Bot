import type DatabaseLib from "better-sqlite3";
import { ulid } from "ulid";
import type { SenryuRecord, SavedSenryuRecord } from "./senryu.types.js";

export function createSenryuRepository(sqlite: DatabaseLib.Database) {
  const insert = sqlite.prepare(
    `INSERT INTO senryu_records (
      id, guild_id, channel_id, message_id, author_id,
      kamigo, nakashichi, shimogo, formatted, source_content, spoiler, detected_at
    ) VALUES (
      @id, @guild_id, @channel_id, @message_id, @author_id,
      @kamigo, @nakashichi, @shimogo, @formatted, @source_content, @spoiler, @detected_at
    )`,
  );

  const del = sqlite.prepare(`DELETE FROM senryu_records WHERE id = ?`);

  return {
    saveSenryu(record: SenryuRecord): SavedSenryuRecord {
      const id = record.id ?? ulid();
      const detectedAt = record.detectedAt;
      insert.run({
        id,
        guild_id: record.guildId,
        channel_id: record.channelId,
        message_id: record.messageId,
        author_id: record.authorId,
        kamigo: record.kamigo,
        nakashichi: record.nakashichi,
        shimogo: record.shimogo,
        formatted: record.formatted,
        source_content: record.sourceContent,
        spoiler: record.spoiler ? 1 : 0,
        detected_at: detectedAt,
      });
      return { ...record, id, detectedAt };
    },

    deleteSenryu(id: string): void {
      del.run(id);
    },
  };
}

export type SenryuRepository = ReturnType<typeof createSenryuRepository>;

// 仕様: 公開 API（内部は同期 DB）

export async function saveSenryu(
  sqlite: DatabaseLib.Database,
  record: SenryuRecord,
): Promise<SavedSenryuRecord> {
  return createSenryuRepository(sqlite).saveSenryu(record);
}

export async function deleteSenryu(sqlite: DatabaseLib.Database, id: string): Promise<void> {
  createSenryuRepository(sqlite).deleteSenryu(id);
}

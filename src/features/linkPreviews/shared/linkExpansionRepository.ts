import type { PgQueryable } from "../../../core/db/postgres.js";

export type ExpansionSource = {
  bot_id: string;
  message_id: string;
  guild_id: string;
  channel_id: string;
  content_hash: string | null;
  expires_at: Date;
};

export type ExpansionRecord = {
  source_message_id: string;
  expansion_key: string;
  response_message_id: string;
  quoted_channel_id: string | null;
  quoted_message_id: string | null;
  quoted_hash: string | null;
};

export async function ensurePostgresLinkExpansionSchema(pool: PgQueryable): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS link_expansion_sources (
      bot_id text NOT NULL,
      message_id text NOT NULL,
      guild_id text NOT NULL,
      channel_id text NOT NULL,
      content_hash text,
      expires_at timestamptz NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '7 days'),
      PRIMARY KEY (bot_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_link_expansion_sources_expiry ON link_expansion_sources(expires_at);
    CREATE TABLE IF NOT EXISTS link_expansion_messages (
      bot_id text NOT NULL,
      source_message_id text NOT NULL,
      expansion_key text NOT NULL,
      response_message_id text NOT NULL UNIQUE,
      quoted_channel_id text,
      quoted_message_id text,
      quoted_hash text,
      PRIMARY KEY (bot_id, source_message_id, expansion_key),
      FOREIGN KEY (bot_id, source_message_id) REFERENCES link_expansion_sources(bot_id, message_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_link_expansion_messages_quote ON link_expansion_messages(quoted_message_id);
  `);
}

export class LinkExpansionRepository {
  constructor(private readonly pool: PgQueryable, private readonly botId: () => string) {}

  async source(id: string): Promise<ExpansionSource | undefined> {
    return (await this.pool.query<ExpansionSource>(
      "SELECT * FROM link_expansion_sources WHERE message_id = $1 AND bot_id = $2 AND expires_at > CURRENT_TIMESTAMP", [id, this.botId()],
    )).rows[0];
  }

  /** 追跡期限は投稿の作成時刻から数える。編集で初めて追跡する古い投稿の期限を延ばさない。 */
  async register(
    message: { id: string; guildId: string | null; channelId: string; createdTimestamp?: number },
  ): Promise<ExpansionSource | undefined> {
    await this.pool.query(`
      INSERT INTO link_expansion_sources(message_id, guild_id, channel_id, bot_id, expires_at)
      VALUES ($1, $2, $3, $4, COALESCE(to_timestamp($5::double precision / 1000.0) + interval '7 days', CURRENT_TIMESTAMP + interval '7 days'))
      ON CONFLICT (bot_id, message_id) DO NOTHING
    `, [message.id, message.guildId, message.channelId, this.botId(), message.createdTimestamp ?? null]);
    return this.source(message.id);
  }

  async records(sourceId: string): Promise<ExpansionRecord[]> {
    return (await this.pool.query<ExpansionRecord>(
      "SELECT * FROM link_expansion_messages WHERE source_message_id = $1 AND bot_id = $2", [sourceId, this.botId()],
    )).rows;
  }

  async save(record: ExpansionRecord): Promise<void> {
    await this.pool.query(`
      INSERT INTO link_expansion_messages
        (source_message_id, expansion_key, response_message_id, quoted_channel_id, quoted_message_id, quoted_hash, bot_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (bot_id, source_message_id, expansion_key) DO UPDATE SET
        response_message_id = EXCLUDED.response_message_id,
        quoted_channel_id = EXCLUDED.quoted_channel_id,
        quoted_message_id = EXCLUDED.quoted_message_id,
        quoted_hash = EXCLUDED.quoted_hash
    `, [record.source_message_id, record.expansion_key, record.response_message_id,
      record.quoted_channel_id, record.quoted_message_id, record.quoted_hash, this.botId()]);
  }

  async wouldCycle(responseId: string, quotedId: string): Promise<boolean> {
    const result = await this.pool.query<{ cycle: boolean }>(`
      WITH RECURSIVE dependencies(message_id) AS (
        VALUES ($1::text)
        UNION
        SELECT m.quoted_message_id FROM link_expansion_messages m
        JOIN link_expansion_sources s ON s.message_id = m.source_message_id AND s.bot_id = m.bot_id
        JOIN dependencies d ON d.message_id = m.response_message_id
        WHERE m.quoted_message_id IS NOT NULL AND s.expires_at > CURRENT_TIMESTAMP
      )
      SELECT EXISTS(SELECT 1 FROM dependencies WHERE message_id = $2) AS cycle
    `, [quotedId, responseId]);
    return result.rows[0]!.cycle;
  }

  async markRendered(sourceId: string, hash: string): Promise<void> {
    await this.pool.query("UPDATE link_expansion_sources SET content_hash = $2 WHERE message_id = $1 AND bot_id = $3", [sourceId, hash, this.botId()]);
  }

  /** 次の定期確認で必ず再描画されるよう、処理済みハッシュを破棄する。 */
  async markIncomplete(sourceId: string): Promise<void> {
    await this.pool.query("UPDATE link_expansion_sources SET content_hash = NULL WHERE message_id = $1 AND bot_id = $2", [sourceId, this.botId()]);
  }

  async forgetResponse(id: string): Promise<void> {
    await this.pool.query("DELETE FROM link_expansion_messages WHERE response_message_id = $1 AND bot_id = $2", [id, this.botId()]);
  }

  async forgetSource(id: string): Promise<void> {
    await this.pool.query("DELETE FROM link_expansion_sources WHERE message_id = $1 AND bot_id = $2", [id, this.botId()]);
  }

  async affected(id: string, includeResponses = false): Promise<ExpansionSource[]> {
    return (await this.pool.query<ExpansionSource>(`
      SELECT DISTINCT s.* FROM link_expansion_sources s
      LEFT JOIN link_expansion_messages m ON m.source_message_id = s.message_id AND m.bot_id = s.bot_id
      WHERE s.expires_at > CURRENT_TIMESTAMP AND s.bot_id = $3 AND
        (s.message_id = $1 OR m.quoted_message_id = $1 OR ($2 AND m.response_message_id = $1))
    `, [id, includeResponses, this.botId()])).rows;
  }

  async page(after = ""): Promise<ExpansionSource[]> {
    return (await this.pool.query<ExpansionSource>(`
      SELECT * FROM link_expansion_sources
      WHERE expires_at > CURRENT_TIMESTAMP AND message_id > $1 AND bot_id = $2 ORDER BY message_id LIMIT 100
    `, [after, this.botId()])).rows;
  }

  async cleanup(): Promise<void> {
    await this.pool.query("DELETE FROM link_expansion_sources WHERE expires_at <= CURRENT_TIMESTAMP AND bot_id = $1", [this.botId()]);
  }
}

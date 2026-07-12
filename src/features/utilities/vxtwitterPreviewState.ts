import type { Kysely } from "kysely";
import type { Database } from "../../core/db/types.js";
import type { TweetPreview } from "./vxtwitterPreview.js";
import type { VxTwitterTextTranslations } from "./vxtwitterTranslation.js";

const TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type VxTwitterPreviewState = {
  messageId: string;
  guildId: string;
  channelId: string;
  tweetUrl: string;
  tweet: TweetPreview;
  translations: VxTwitterTextTranslations;
};

export async function saveVxTwitterPreviewState(db: Kysely<Database>, state: VxTwitterPreviewState): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TTL_MS);
  await db.insertInto("vx_twitter_preview_states").values({
    message_id: state.messageId, guild_id: state.guildId, channel_id: state.channelId, tweet_url: state.tweetUrl,
    tweet: state.tweet as unknown as Record<string, unknown>, translations: state.translations as unknown as Record<string, unknown>,
    expires_at: expiresAt, created_at: now, updated_at: now,
  }).onConflict((oc) => oc.column("message_id").doUpdateSet({
    guild_id: state.guildId, channel_id: state.channelId, tweet_url: state.tweetUrl,
    tweet: state.tweet as unknown as Record<string, unknown>, translations: state.translations as unknown as Record<string, unknown>,
    expires_at: expiresAt, updated_at: now,
  })).execute();
}

export async function getVxTwitterPreviewState(db: Kysely<Database>, messageId: string): Promise<VxTwitterPreviewState | null> {
  const row = await db.selectFrom("vx_twitter_preview_states").selectAll().where("message_id", "=", messageId).where("expires_at", ">", new Date()).executeTakeFirst();
  if (!row) return null;
  return { messageId: row.message_id, guildId: row.guild_id, channelId: row.channel_id, tweetUrl: row.tweet_url,
    tweet: row.tweet as unknown as TweetPreview, translations: row.translations as unknown as VxTwitterTextTranslations };
}

export async function deleteExpiredVxTwitterPreviewStates(db: Kysely<Database>): Promise<void> {
  await db.deleteFrom("vx_twitter_preview_states").where("expires_at", "<=", new Date()).execute();
}

import type { Kysely } from "kysely";
import type { Database } from "../../../core/db/types.js";
import type { TweetPreview } from "./vxtwitterPreview.js";
import type { VxTwitterTextTranslations } from "./vxtwitterTranslation.js";

export type VxTwitterPreviewState = {
  messageId: string;
  guildId: string;
  channelId: string;
  tweetUrl: string;
  tweet: TweetPreview;
  translations: VxTwitterTextTranslations;
};

export async function getVxTwitterPreviewState(db: Kysely<Database>, messageId: string): Promise<VxTwitterPreviewState | null> {
  const row = await db.selectFrom("vx_twitter_preview_states").selectAll().where("message_id", "=", messageId).where("expires_at", ">", new Date()).executeTakeFirst();
  if (!row) return null;
  return { messageId: row.message_id, guildId: row.guild_id, channelId: row.channel_id, tweetUrl: row.tweet_url,
    tweet: row.tweet as unknown as TweetPreview, translations: row.translations as unknown as VxTwitterTextTranslations };
}

export async function deleteExpiredVxTwitterPreviewStates(db: Kysely<Database>): Promise<void> {
  await db.deleteFrom("vx_twitter_preview_states").where("expires_at", "<=", new Date()).execute();
}

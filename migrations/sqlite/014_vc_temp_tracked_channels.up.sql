CREATE TABLE IF NOT EXISTS vc_temp_tracked_channels (
  channel_id TEXT NOT NULL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  user_ever_joined INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_vc_temp_tracked_guild ON vc_temp_tracked_channels (guild_id);

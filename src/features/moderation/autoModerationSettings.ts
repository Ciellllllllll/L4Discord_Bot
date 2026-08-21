import type { BotContext } from "../../bot/context.js";
import { nowIso } from "../../core/db/nowIso.js";
import type { AutoModSettings } from "./autoModerationTypes.js";

function defaultModlogChannelId(ctx: BotContext): string {
  const c = ctx.config;
  return String(c.MOD_LOG_CHANNEL_ID || c.LOGGER_CHANNEL_ID || c.LOG_CHANNEL_ID || "").trim();
}

export function getDefaultAutoModSettings(ctx: BotContext): AutoModSettings {
  const modlogChannelId = defaultModlogChannelId(ctx);
  return {
    enabled: true,
    linkBlock: false,
    inviteBlock: false,
    spamBlock: true,
    raidMode: false,
    spamWindowSec: 8,
    spamThreshold: 6,
    timeoutSec: 600,
    modlogChannelId: /^\d+$/.test(modlogChannelId) ? modlogChannelId : "",
  };
}

type StoredAutoMod = Partial<AutoModSettings> & { anti_raid_mode?: boolean };

function normalizeStored(raw: unknown): Partial<AutoModSettings> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const o = raw as StoredAutoMod;
  const next: Partial<AutoModSettings> = { ...o };
  if (typeof next.raidMode !== "boolean" && typeof o.anti_raid_mode === "boolean") {
    next.raidMode = o.anti_raid_mode;
  }
  if (next.modlogChannelId !== undefined) {
    next.modlogChannelId = String(next.modlogChannelId).trim();
  }
  return next;
}

function parseRowData(data: unknown): Partial<AutoModSettings> {
  try {
    const raw = typeof data === "string" ? (JSON.parse(data) as unknown) : data;
    return normalizeStored(raw);
  } catch {
    return {};
  }
}

export async function getMergedAutoModSettings(ctx: BotContext, guildId: string): Promise<AutoModSettings> {
  const row = await ctx.automodDb
    .selectFrom("automod_guild_settings")
    .selectAll()
    .where("guild_id", "=", guildId)
    .executeTakeFirst();
  const stored = row ? parseRowData(row.data) : {};
  const defaults = getDefaultAutoModSettings(ctx);
  return {
    ...defaults,
    ...stored,
  };
}

export async function updateAutoModSettings(
  ctx: BotContext,
  guildId: string,
  patch: Partial<AutoModSettings>,
): Promise<AutoModSettings> {
  const current = await getMergedAutoModSettings(ctx, guildId);
  const nextPatch = { ...patch };
  if (Object.prototype.hasOwnProperty.call(nextPatch, "raidMode")) {
    const raidMode = Boolean(nextPatch.raidMode);
    (nextPatch as StoredAutoMod).raidMode = raidMode;
    (nextPatch as StoredAutoMod).anti_raid_mode = raidMode;
  }
  const next: AutoModSettings = {
    ...current,
    ...nextPatch,
  };

  await ctx.automodDb
    .insertInto("automod_guild_settings")
    .values({
      guild_id: guildId,
      data: JSON.stringify(next) as unknown as Record<string, unknown>,
      updated_at: nowIso() as unknown as Date,
    })
    .onConflict((oc) =>
      oc.column("guild_id").doUpdateSet({
        data: JSON.stringify(next) as unknown as Record<string, unknown>,
        updated_at: nowIso() as unknown as Date,
      }),
    )
    .execute();

  return next;
}

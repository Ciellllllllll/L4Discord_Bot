import { ChannelType } from "discord.js";
import type { BotContext } from "../../bot/context.js";

export function startReminderScheduler(ctx: BotContext, intervalMs = 60_000): NodeJS.Timeout {
  ctx.log.info({ intervalMs }, "reminder scheduler started");
  return setInterval(() => {
    void (async () => {
      const now = new Date().toISOString();
      const rows = await ctx.db
        .selectFrom("reminders")
        .selectAll()
        .where("status", "=", "pending")
        .where("fire_at", "<=", now)
        .limit(15)
        .execute();
      for (const r of rows) {
        const ch = await ctx.client.channels.fetch(r.channel_id).catch(() => null);
        if (
          ch &&
          (ch.type === ChannelType.GuildText ||
            ch.type === ChannelType.GuildAnnouncement ||
            ch.type === ChannelType.PublicThread ||
            ch.type === ChannelType.PrivateThread)
        ) {
          await ch.send(`🔔 <@${r.author_id}> ${r.body}`.slice(0, 2000)).catch(() => undefined);
        }
        await ctx.db.updateTable("reminders").set({ status: "fired" }).where("id", "=", r.id).execute();
      }
      if (rows.length > 0) {
        ctx.log.info({ count: rows.length }, "reminders delivered");
      }
    })().catch((e) => ctx.log.error({ err: e }, "reminder tick failed"));
  }, intervalMs);
}

import type { BotContext } from "../../bot/context.js";
import { sqliteTimestamp } from "../../core/db/sqliteTimestamp.js";

export async function logModmailEvent(
  ctx: BotContext,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await ctx.ticketDb
      .insertInto("modmail_events")
      .values({
        event_type: eventType,
        payload: JSON.stringify(payload),
        created_at: sqliteTimestamp() as unknown as Date,
      })
      .execute();
  } catch (e) {
    ctx.log.warn({ err: e, eventType }, "modmail event log failed");
  }
}

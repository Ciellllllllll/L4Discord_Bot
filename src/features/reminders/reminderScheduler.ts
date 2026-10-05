import type { BotContext } from "../../bot/context.js";
import { applyDispatchResult, fetchDuePending } from "./reminderHubRepo.js";
import { sendReminderHubMessage } from "./reminderHubSend.js";
import { finalizeDueBokeruRounds } from "../bokeru/bokeru.js";

export function startReminderScheduler(ctx: BotContext, intervalMs = 30_000): NodeJS.Timeout {
  ctx.log.debug({ intervalMs }, "reminder scheduler started");
  return setInterval(() => {
    void (async () => {
      const now = new Date().toISOString();
      const rows = await fetchDuePending(ctx, now, 50);
      for (const r of rows) {
        await sendReminderHubMessage(ctx, r);
        await applyDispatchResult(ctx, r, false);
      }
      if (rows.length > 0) {
        ctx.log.info({ count: rows.length }, "reminders delivered");
      }
    })().catch((e) => ctx.log.error({ err: e }, "reminder tick failed"));
    void finalizeDueBokeruRounds(ctx).catch((e) => ctx.log.error({ err: e }, "bokeru sweep failed"));
  }, intervalMs);
}

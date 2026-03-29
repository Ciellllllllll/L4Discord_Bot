import { ActivityType, type Client } from "discord.js";
import type pino from "pino";

const ROTATE_MS = 60_000;
const DEFAULT_LINES = ["L4Discord", "/q で質問", "運営Bot稼働中"];

export function startPresenceRotation(client: Client, log: pino.Logger, version: string): NodeJS.Timeout {
  let i = 0;
  const lines = [...DEFAULT_LINES, `v${version}`];
  const tick = () => {
    const name = lines[i % lines.length] ?? "L4";
    i += 1;
    const u = client.user;
    if (!u) return;
    void (async () => {
      try {
        await u.setPresence({
          activities: [{ name, type: ActivityType.Playing }],
          status: "online",
        });
      } catch (err) {
        log.warn({ err }, "setPresence failed");
        try {
          await u.setPresence({
            activities: [{ name: "接続エラー", type: ActivityType.Playing }],
            status: "idle",
          });
        } catch {
          /* ignore */
        }
      }
    })();
  };
  tick();
  return setInterval(tick, ROTATE_MS);
}

import { ActivityType, type Client } from "discord.js";
import type pino from "pino";

const PRESENCE_UPDATE_MS = 60_000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;
const SECONDS_PER_MONTH = 30 * SECONDS_PER_DAY;
const SECONDS_PER_YEAR = 365 * SECONDS_PER_DAY;

export function formatUptime(totalSeconds: number): string {
  let remaining = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const years = Math.floor(remaining / SECONDS_PER_YEAR);
  remaining %= SECONDS_PER_YEAR;
  const months = Math.floor(remaining / SECONDS_PER_MONTH);
  remaining %= SECONDS_PER_MONTH;
  const days = Math.floor(remaining / SECONDS_PER_DAY);
  remaining %= SECONDS_PER_DAY;
  const hours = Math.floor(remaining / SECONDS_PER_HOUR);
  remaining %= SECONDS_PER_HOUR;
  const minutes = Math.floor(remaining / SECONDS_PER_MINUTE);

  const parts = [
    years > 0 ? `${years}y` : null,
    months > 0 ? `${months}mo` : null,
    days > 0 ? `${days}d` : null,
    hours > 0 ? `${hours}h` : null,
    minutes > 0 ? `${minutes}m` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" ") : "0m";
}

export function startPresence(
  client: Client,
  log: pino.Logger,
  getUptimeSeconds: () => number = () => 0,
  options: {
    setInterval?: (callback: () => void, delay: number) => NodeJS.Timeout;
  } = {},
): NodeJS.Timeout {
  log.debug({ intervalMs: PRESENCE_UPDATE_MS }, "uptime presence started");
  const tick = () => {
    const user = client.user;
    if (!user) return;
    const name = `稼働時間: ${formatUptime(getUptimeSeconds())}`;
    void (async () => {
      try {
        await user.setPresence({
          activities: [{ name, type: ActivityType.Playing }],
          status: "online",
        });
      } catch (err) {
        log.warn({ err }, "setPresence failed");
      }
    })();
  };
  tick();
  return (options.setInterval ?? setInterval)(tick, PRESENCE_UPDATE_MS);
}

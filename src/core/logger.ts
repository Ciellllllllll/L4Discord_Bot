import pino from "pino";
import type { AppConfig } from "./config.js";

function resolveLogLevel(logDebug: AppConfig["LOG_DEBUG"]): pino.Level {
  if (logDebug === true) return "debug";
  if (logDebug === false) return "info";
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

function usePrettyTransport(): boolean {
  if (process.env.NODE_ENV === "production") {
    return false;
  }
  const v = process.env.LOG_PRETTY;
  if (v === "0" || v === "false" || v === "no") {
    return false;
  }
  return true;
}

export function createLogger(config: Pick<AppConfig, "LOG_DEBUG">): pino.Logger {
  const level = resolveLogLevel(config.LOG_DEBUG);

  if (usePrettyTransport()) {
    const colorize = process.platform !== "win32";
    return pino({
      level,
      transport: {
        target: "pino-pretty",
        options: {
          colorize,
          translateTime: "SYS:HH:MM:ss",
          ignore: "pid,hostname",
          errorLikeObjectKeys: ["err", "error"],
        },
      },
    });
  }

  return pino({ level });
}

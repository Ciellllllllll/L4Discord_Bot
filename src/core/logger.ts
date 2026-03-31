import pino from "pino";

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

export function createLogger(): pino.Logger {
  const level = process.env.NODE_ENV === "production" ? "info" : "debug";

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

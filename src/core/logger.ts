import pino from "pino";

export function createLogger(): pino.Logger {
  return pino({
    level: process.env.NODE_ENV === "production" ? "info" : "debug",
  });
}

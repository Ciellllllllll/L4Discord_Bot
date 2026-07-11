import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../core/config.js";
import {
  checkConfiguredPaths,
  checkPostgresCutoverEnvironment,
  postgresCutoverSourcePaths,
} from "./checkPostgresCutoverReadiness.js";

function baseEnv(root: string, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    DISCORD_TOKEN: "token",
    DISCORD_CLIENT_ID: "client",
    GUILD_ID: "guild",
    OWNER_ID: "owner",
    ADMIN_ROLE_ID: "admin",
    PROFILE: "production",
    DATABASE_URL: "postgres://user:pass@127.0.0.1:5432/l4discord",
    DATABASE_PATH: join(root, "l4discord.sqlite"),
    TICKET_DATABASE_PATH: join(root, "ticket.db"),
    MESSAGE_LOG_DB_PATH: join(root, "message.db"),
    MESSAGE_ATTACHMENT_STORE_DB_PATH: join(root, "message_attachment_store.db"),
    MESSAGE_ATTACHMENT_FILES_DIR: join(root, "message_log_attachments"),
    VC_TIME_DATABASE_PATH: join(root, "vc_time.db"),
    AI_HISTORY_DATABASE_PATH: join(root, "AI_History.db"),
    AUTOMODERATION_DATABASE_PATH: join(root, "Automoderation.db"),
    REMINDER_DATABASE_PATH: join(root, "reminder.db"),
    ...extra,
  };
}

const root = join(tmpdir(), `l4-cutover-readiness-${process.pid}-${Date.now()}`);
mkdirSync(root, { recursive: true });
try {
  writeFileSync(join(root, "l4discord.sqlite"), "");
  writeFileSync(join(root, "ticket.db"), "");
  mkdirSync(join(root, "message_log_attachments"));

  const config = loadConfig(baseEnv(root));
  assert.equal(postgresCutoverSourcePaths(config).length, 9);

  const pathChecks = checkConfiguredPaths(config);
  assert.equal(pathChecks.find((check) => check.label === "main SQLite")?.status, "ok");
  assert.equal(pathChecks.find((check) => check.label === "ticket SQLite")?.status, "ok");
  assert.equal(pathChecks.find((check) => check.label === "message log SQLite")?.status, "fail");
  assert.equal(pathChecks.find((check) => check.label === "message attachment files")?.status, "ok");
  assert.equal(
    checkConfiguredPaths(config, true).find((check) => check.label === "message log SQLite")?.status,
    "warn",
  );

  const envChecks = checkPostgresCutoverEnvironment(config);
  assert.equal(envChecks.find((check) => check.label === "DATABASE_URL")?.status, "ok");
  assert.equal(envChecks.find((check) => check.label === "DB_DRIVER")?.status, "warn");

  const duplicateSchemaConfig = loadConfig(baseEnv(root, {
    POSTGRES_MAIN_SCHEMA: "same_schema",
    POSTGRES_TICKET_SCHEMA: "same_schema",
  }));
  assert.equal(
    checkPostgresCutoverEnvironment(duplicateSchemaConfig).find((check) => check.label === "schema ticket")?.status,
    "fail",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("checkPostgresCutoverReadiness.spec.ts: all assertions passed");

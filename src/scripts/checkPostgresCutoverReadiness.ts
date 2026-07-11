import "dotenv/config";
import { existsSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadConfig, type AppConfig } from "../core/config.js";
import { createPgPool } from "../core/db/postgres.js";

type CheckStatus = "ok" | "warn" | "fail";

type CheckItem = {
  status: CheckStatus;
  label: string;
  detail: string;
};

type SourcePath = {
  label: string;
  path: string;
  kind: "file" | "directory";
};

function item(status: CheckStatus, label: string, detail: string): CheckItem {
  return { status, label, detail };
}

export function postgresCutoverSourcePaths(config: AppConfig): SourcePath[] {
  return [
    { label: "main SQLite", path: config.DATABASE_PATH, kind: "file" },
    { label: "ticket SQLite", path: config.TICKET_DATABASE_PATH, kind: "file" },
    { label: "message log SQLite", path: config.MESSAGE_LOG_DB_PATH, kind: "file" },
    { label: "message attachment metadata SQLite", path: config.MESSAGE_ATTACHMENT_STORE_DB_PATH, kind: "file" },
    { label: "VC time SQLite", path: config.VC_TIME_DATABASE_PATH, kind: "file" },
    { label: "AI history SQLite", path: config.AI_HISTORY_DATABASE_PATH, kind: "file" },
    { label: "automoderation SQLite", path: config.AUTOMODERATION_DATABASE_PATH, kind: "file" },
    { label: "reminder SQLite", path: config.REMINDER_DATABASE_PATH, kind: "file" },
    { label: "message attachment files", path: config.MESSAGE_ATTACHMENT_FILES_DIR, kind: "directory" },
  ];
}

export function checkConfiguredPaths(config: AppConfig, allowMissingSources = false): CheckItem[] {
  return postgresCutoverSourcePaths(config).map((source) => {
    if (!existsSync(source.path)) {
      return item(
        allowMissingSources ? "warn" : "fail",
        source.label,
        `${source.path} does not exist${allowMissingSources ? "; migration will skip this source" : ""}`,
      );
    }
    const stats = statSync(source.path);
    const matchesKind = source.kind === "file" ? stats.isFile() : stats.isDirectory();
    if (!matchesKind) {
      return item("fail", source.label, `${source.path} exists but is not a ${source.kind}`);
    }
    return item("ok", source.label, source.path);
  });
}

export function checkPostgresCutoverEnvironment(config: AppConfig): CheckItem[] {
  const schemaNames = [
    ["main", config.POSTGRES_MAIN_SCHEMA],
    ["ticket", config.POSTGRES_TICKET_SCHEMA],
    ["message_log", config.POSTGRES_MESSAGE_LOG_SCHEMA],
    ["message_attachment", config.POSTGRES_MESSAGE_ATTACHMENT_SCHEMA],
    ["vc_time", config.POSTGRES_VC_TIME_SCHEMA],
    ["ai_history", config.POSTGRES_AI_HISTORY_SCHEMA],
    ["automod", config.POSTGRES_AUTOMOD_SCHEMA],
    ["reminder", config.POSTGRES_REMINDER_SCHEMA],
  ] as const;
  const seen = new Map<string, string>();
  const checks: CheckItem[] = [
    item("ok", "profile", config.BOT_PROFILE),
    item(config.DB_DRIVER === "postgres" ? "ok" : "warn", "DB_DRIVER", `${config.DB_DRIVER}; set postgres before final startup`),
    config.DATABASE_URL
      ? item("ok", "DATABASE_URL", "configured")
      : item("fail", "DATABASE_URL", "required for migrate:sqlite-to-postgres and DB_DRIVER=postgres"),
  ];

  for (const [label, schema] of schemaNames) {
    if (seen.has(schema)) {
      checks.push(item("fail", `schema ${label}`, `${schema} duplicates ${seen.get(schema)}`));
    } else {
      seen.set(schema, label);
      checks.push(item("ok", `schema ${label}`, schema));
    }
  }
  return checks;
}

async function checkPostgresConnection(config: AppConfig): Promise<CheckItem[]> {
  if (!config.DATABASE_URL) return [];
  let pool: Awaited<ReturnType<typeof createPgPool>> | undefined;
  try {
    pool = await createPgPool(config.DATABASE_URL);
    const result = await pool.query<{ database: string; user_name: string; server_version: string }>(
      "SELECT current_database() AS database, current_user AS user_name, current_setting('server_version') AS server_version",
    );
    const row = result.rows[0];
    return [
      item(
        "ok",
        "PostgreSQL connection",
        row ? `${row.database} as ${row.user_name} (${row.server_version})` : "connected",
      ),
    ];
  } catch (error) {
    return [item("fail", "PostgreSQL connection", error instanceof Error ? error.message : String(error))];
  } finally {
    await pool?.end();
  }
}

function renderCheck(check: CheckItem): string {
  const prefix = check.status === "ok" ? "[ok]" : check.status === "warn" ? "[warn]" : "[fail]";
  return `${prefix} ${check.label}: ${check.detail}`;
}

function shouldSkipPostgres(args: string[]): boolean {
  return args.includes("--skip-postgres") || args.includes("--no-postgres");
}

function shouldAllowMissingSources(args: string[]): boolean {
  return args.includes("--allow-missing-sources");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const skipPostgres = shouldSkipPostgres(args);
  const allowMissingSources = shouldAllowMissingSources(args);
  const config = loadConfig();
  const checks = [
    ...checkPostgresCutoverEnvironment(config),
    ...checkConfiguredPaths(config, allowMissingSources),
    ...(allowMissingSources ? [item("warn", "missing source policy", "--allow-missing-sources enabled")] : []),
    ...(skipPostgres ? [item("warn", "PostgreSQL connection", "skipped by --skip-postgres")] : await checkPostgresConnection(config)),
  ];

  for (const check of checks) console.log(renderCheck(check));
  const failures = checks.filter((check) => check.status === "fail");
  if (failures.length > 0) {
    console.error(`PostgreSQL cutover readiness failed: ${failures.length} failure(s).`);
    process.exitCode = 1;
    return;
  }
  const warnings = checks.filter((check) => check.status === "warn");
  console.log(`PostgreSQL cutover readiness passed with ${warnings.length} warning(s).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

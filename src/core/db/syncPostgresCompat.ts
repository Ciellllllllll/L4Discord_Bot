import { execFileSync } from "node:child_process";
import { quotePgIdent } from "./postgres.js";

type RunResult = {
  changes: number;
  lastInsertRowid: number | bigint;
};

type BindValue = string | number | bigint | boolean | null | undefined | Buffer | Date;
type BindParams = BindValue[] | Record<string, BindValue>;

function pgLiteral(value: BindValue): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "NULL";
    return String(value);
  }
  if (typeof value === "bigint") return pgLiteral(value.toString());
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) return pgLiteral(value.toISOString());
  if (Buffer.isBuffer(value)) return `decode('${value.toString("hex")}', 'hex')`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

function normalizeParams(params: unknown[]): BindParams {
  if (params.length === 1 && params[0] && typeof params[0] === "object" && !Array.isArray(params[0]) && !Buffer.isBuffer(params[0])) {
    return params[0] as Record<string, BindValue>;
  }
  return params as BindValue[];
}

function bindSql(sql: string, params: BindParams): string {
  if (Array.isArray(params)) {
    let index = 0;
    return sql.replace(/\?/g, () => pgLiteral(params[index++]));
  }
  return sql.replace(/[@:$]([A-Za-z_][A-Za-z0-9_]*)/g, (match, name: string) => {
    if (!(name in params)) return match;
    return pgLiteral(params[name]);
  });
}

function stripTrailingSemicolon(sql: string): string {
  return sql.trim().replace(/;+\s*$/, "");
}

function pragmaTableInfoName(sql: string): string | null {
  const match = /^\s*PRAGMA\s+table_info\s*\(\s*["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?\s*\)\s*;?\s*$/i.exec(sql);
  return match?.[1] ?? null;
}

function quoteCamelCaseAliases(sql: string): string {
  return sql.replace(/\bAS\s+([A-Za-z_][A-Za-z0-9_]*)\b/g, (match, alias: string) => {
    if (!/[A-Z]/.test(alias)) return match;
    return `AS ${quotePgIdent(alias)}`;
  });
}

function translateSql(sql: string): string {
  let next = stripTrailingSemicolon(sql);
  next = quoteCamelCaseAliases(next);
  next = next.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, "INSERT INTO");
  if (/^\s*INSERT\s+INTO\b/i.test(next) && !/\bON\s+CONFLICT\b/i.test(next)) {
    next += " ON CONFLICT DO NOTHING";
  }
  next = next.replace(
    /MAX\(\s*steam_paid_price_history\.normal_price_cents\s*,\s*excluded\.normal_price_cents\s*\)/gi,
    "GREATEST(steam_paid_price_history.normal_price_cents, excluded.normal_price_cents)",
  );
  next = next.replace(
    /min\(\s*pacchi_sentence_patterns\.safe_level\s*,\s*excluded\.safe_level\s*\)/gi,
    "LEAST(pacchi_sentence_patterns.safe_level, excluded.safe_level)",
  );
  return next;
}

function normalizeRow(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeRow);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = normalizeRow(entry);
  }
  return out;
}

function parseJsonLines(source: string): unknown[] {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export class SyncPostgresStatement {
  constructor(
    private readonly db: SyncPostgresCompatDatabase,
    private readonly sourceSql: string,
  ) {}

  get<T = unknown>(...params: unknown[]): T | undefined {
    return this.all<T>(...params)[0];
  }

  all<T = unknown>(...params: unknown[]): T[] {
    const sql = translateSql(bindSql(this.sourceSql, normalizeParams(params)));
    const table = pragmaTableInfoName(sql);
    if (table) {
      return this.db.tableInfo(table) as T[];
    }
    const out = this.db.queryJsonLines(sql);
    return out.map((row) => normalizeRow(row) as T);
  }

  run(...params: unknown[]): RunResult {
    const sql = translateSql(bindSql(this.sourceSql, normalizeParams(params)));
    const changes = this.db.executeMutation(sql);
    return { changes, lastInsertRowid: 0 };
  }
}

export class SyncPostgresCompatDatabase {
  constructor(
    private readonly connectionString: string,
    private readonly schema: string,
  ) {}

  prepare(sql: string): SyncPostgresStatement {
    return new SyncPostgresStatement(this, sql);
  }

  exec(sql: string): void {
    if (/\bCREATE\s+(?:VIRTUAL\s+)?TABLE\b|\bCREATE\s+(?:UNIQUE\s+)?INDEX\b|\bCREATE\s+TRIGGER\b|\bDROP\s+TRIGGER\b|\bALTER\s+TABLE\b/i.test(sql)) {
      return;
    }
    this.psql(translateSql(sql));
  }

  pragma(_source: string): unknown {
    return [];
  }

  defaultSafeIntegers(_enabled?: boolean): this {
    return this;
  }

  close(): void {
    return;
  }

  transaction<T extends (...args: any[]) => any>(fn: T): T {
    return ((...args: Parameters<T>) => fn(...args)) as T;
  }

  queryJsonLines(sql: string): unknown[] {
    const wrapped = `SELECT row_to_json(__q) FROM (${sql}) AS __q`;
    return parseJsonLines(this.psql(wrapped));
  }

  tableInfo(table: string): Array<{ cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number }> {
    return this.queryJsonLines(
      `
        SELECT
          (ordinal_position - 1)::int AS cid,
          column_name AS name,
          data_type AS type,
          CASE WHEN is_nullable = 'NO' THEN 1 ELSE 0 END AS notnull,
          column_default AS dflt_value,
          0 AS pk
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = ${pgLiteral(table)}
        ORDER BY ordinal_position
      `,
    ) as Array<{ cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>;
  }

  executeMutation(sql: string): number {
    const trimmed = sql.trim();
    if (/^(UPDATE|DELETE)\b/i.test(trimmed) && !/\bRETURNING\b/i.test(trimmed)) {
      const wrapped = `WITH __dml AS (${trimmed} RETURNING 1) SELECT row_to_json(__q) FROM (SELECT count(*)::int AS changes FROM __dml) AS __q`;
      const rows = parseJsonLines(this.psql(wrapped)) as Array<{ changes?: number }>;
      return Number(rows[0]?.changes ?? 0);
    }
    if (/^INSERT\b/i.test(trimmed) && !/\bRETURNING\b/i.test(trimmed)) {
      this.psql(trimmed);
      return 1;
    }
    const rows = this.queryJsonLines(trimmed) as unknown[];
    return rows.length;
  }

  private psql(sql: string): string {
    const searchPath = `${quotePgIdent(this.schema)},public`;
    const fullSql = `SET search_path TO ${searchPath};\n${sql}`;
    const url = new URL(this.connectionString);
    return execFileSync(
      "psql",
      [
        "-h",
        url.hostname,
        "-p",
        url.port || "5432",
        "-U",
        decodeURIComponent(url.username),
        "-d",
        decodeURIComponent(url.pathname.replace(/^\//, "")),
        "-X",
        "-q",
        "-v",
        "ON_ERROR_STOP=1",
        "-t",
        "-A",
        "-c",
        fullSql,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PGPASSWORD: decodeURIComponent(url.password),
        },
        maxBuffer: 32 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
  }
}

export function createSyncPostgresCompatDatabase(connectionString: string, schema: string): SyncPostgresCompatDatabase {
  return new SyncPostgresCompatDatabase(connectionString, schema);
}

/**
 * better-sqlite3 は Date をバインドできない。スキーマ上 TEXT の日時列には ISO 8601 文字列を渡す。
 * Kysely の型が Date の列は `as unknown as Date` で渡す。
 */
export function sqliteTimestamp(): string {
  return new Date().toISOString();
}

// PostgreSQLの時刻列へ渡すISO 8601 UTC文字列を生成する。

export function nowIso(): string {
  return new Date().toISOString();
}

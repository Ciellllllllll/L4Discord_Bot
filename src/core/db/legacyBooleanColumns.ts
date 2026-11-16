import { quotePgIdent, type PgQueryable } from "./postgres.js";

export type LegacyBooleanColumn = {
  table: string;
  column: string;
  /** 変換後に付ける既定値。null なら既定値を付けない。 */
  defaultValue: boolean | null;
};

/**
 * SQLite から移した PostgreSQL のコピーでは、true/false の列が 0/1 の bigint として
 * 作られている場合がある。コードは boolean を書き込むため、該当する列だけ boolean に直す。
 * 既に boolean の列や存在しない列は変更しないので、何度実行しても結果は同じ。
 */
export async function migrateLegacyBooleanColumns(pool: PgQueryable, columns: readonly LegacyBooleanColumn[]): Promise<void> {
  for (const { table, column, defaultValue } of columns) {
    const result = await pool.query<{ data_type: string }>(
      `SELECT data_type
       FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
      [table, column],
    );
    if (result.rows[0]?.data_type !== "bigint") continue;

    const t = quotePgIdent(table);
    const c = quotePgIdent(column);
    const setDefault = defaultValue === null ? "" : `, ALTER COLUMN ${c} SET DEFAULT ${defaultValue ? "true" : "false"}`;
    await pool.query(`
      ALTER TABLE ${t}
        ALTER COLUMN ${c} DROP DEFAULT,
        ALTER COLUMN ${c} TYPE boolean USING ${c} <> 0${setDefault}
    `);
  }
}

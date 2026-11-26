import type { LegacyBooleanColumn } from "./legacyBooleanColumns.js";

/**
 * SQLite から移したときに bigint で作られ、コードは boolean を書き込むフラグ列。
 * version 11 は pacchi の設定列だけを直していた。
 */
export const LEGACY_FLAG_COLUMNS: readonly LegacyBooleanColumn[] = [
  { table: "pacchi_lexicon", column: "is_proper_noun", defaultValue: false },
  { table: "pacchi_lexicon", column: "is_oov", defaultValue: false },
  { table: "senryu_records", column: "spoiler", defaultValue: null },
  { table: "lol_watcher_accounts", column: "enabled", defaultValue: true },
];

# PostgreSQL migration

This bot historically stores data in multiple SQLite files. The migration tooling copies those files into one
PostgreSQL database using separate schemas:

- `main`
- `ticket`
- `message_log`
- `message_attachment`
- `vc_time`
- `ai_history`
- `automod`
- `reminder`

Schema names can be overridden with `POSTGRES_*_SCHEMA` environment variables.

## Environment

Set:

```env
DATABASE_URL=postgres://l4bot:password@127.0.0.1:5432/l4discord
```

`DB_DRIVER=postgres` enables PostgreSQL for Kysely-backed repositories. Some legacy synchronous repositories still
use SQLite connections and must be ported before a full runtime cutover.

## One-shot data copy

Stop the bot first, then back up the SQLite files from the active profile directory.

```powershell
npm run migrate:sqlite-to-postgres
npm run verify:postgres-data
```

The copy script:

- reads the configured SQLite files
- creates PostgreSQL schemas and tables from the live SQLite schema
- copies all non-FTS tables
- converts Discord Snowflake columns to text
- recreates primary keys and unique indexes where they can be inferred from SQLite metadata
- resets identity sequences for integer `id` columns

`message_logs_fts` and its shadow tables are intentionally skipped. The bot's current message-log search path uses
`LIKE`, so the FTS table is not required for behavior parity.

## Runtime status

Implemented:

- PostgreSQL dependency and config
- Kysely PostgreSQL factories
- Kysely-backed main/ticket/AI-history/automod/reminder DB routing
- SQLite-to-PostgreSQL copy script
- copy verification script

Still required before a full `DB_DRIVER=postgres` production cutover:

- port `better-sqlite3` direct repositories to async PostgreSQL implementations
- cover message log, message attachment metadata, VC session tracking/ranking, Pacchi, Senryu, GameDeals, and LolWatcher
- remove legacy SQLite runtime dependencies after those ports pass tests


# PostgreSQL migration and production cutover

The bot runtime requires PostgreSQL and keeps one database connection URL separated by schema:

- `main`
- `ticket`
- `message_log`
- `message_attachment`
- `vc_time`
- `ai_history`
- `automod`
- `reminder`

Schema names can be overridden with `POSTGRES_*_SCHEMA` or profile-specific `PRODUCTION_POSTGRES_*_SCHEMA` /
`DEBUG_POSTGRES_*_SCHEMA` environment variables.

## Runtime status

The bot uses direct PostgreSQL paths for runtime repositories that previously required the synchronous SQLite
compatibility layer:

- Pacchi memory, sleep/report logs, import/export, and Senryu submissions
- Senryu records
- LolWatcher accounts, active games, notifications, and status
- VC session ranking and temporary VC tracked-channel restore state
- Message log search/detail/export and message attachment metadata reads
- Existing PostgreSQL paths for VC session writes, message log/attachment writes, Game Deals, AI provider settings,
  ticket DB, AI history, automoderation, reminders, and Kysely-backed main tables

Startup applies versioned schema migrations through `postgres_schema_migrations`. SQLite files and source DDL remain
only for one-way migration and verification; the bot runtime cannot start without PostgreSQL.

## Environment

Minimum PostgreSQL runtime settings:

```env
BOT_PROFILE=production
DATABASE_URL=postgres://l4bot:password@127.0.0.1:5432/l4discord
```

For production profile-specific overrides, prefer:

```env
BOT_PROFILE=production
PRODUCTION_DATABASE_URL=postgres://l4bot:password@127.0.0.1:5432/l4discord
```

If schema names are omitted, the defaults listed above are used.

## Local verification

Run the full SQLite + PostgreSQL spec suite before preparing a production cutover:

```powershell
mise exec -- npm run typecheck
mise exec -- npm test
mise exec -- npm run build
```

`npm test` starts Docker PostgreSQL, runs all specs, exercises SQLite-to-PostgreSQL migration fixtures, and runs
`verifyPostgresData.ts` against the migrated fixture. Use `npm run test:sqlite` only for a quick local loop that does
not require Docker; it is not the cutover or CI gate.

On the production host, before stopping the bot, run the read-only cutover readiness check:

```bash
BOT_PROFILE=production npm run check:postgres-cutover
```

This checks configured SQLite source paths, schema-name uniqueness, `DATABASE_URL`, and PostgreSQL connectivity. It
does not copy data, create schemas, change environment variables, or stop/start the bot.
Missing SQLite source files are treated as failures by default. If a legacy DB was intentionally never created, use
`-- --allow-missing-sources` only after confirming each reported missing source individually and recording that no data
is expected there.

## Planned production cutover

Do this only during a planned outage. Do not run migration while the bot is still writing to SQLite.
Before step 1, run `BOT_PROFILE=production npm run check:postgres-cutover` and resolve every `fail` result. Treat missing
SQLite sources as a blocker unless you have explicitly confirmed that the specific legacy database was never used.

1. Stop the bot process.
2. Record the current commit/branch and current environment file.
3. Back up all active SQLite files and attachment files for the active profile.
4. Run the SQLite-to-PostgreSQL copy.
5. Run the PostgreSQL data verifier.
6. Deploy the PostgreSQL-only runtime configuration.
7. Start the bot.
8. Run smoke tests.

### 1. Stop the bot

Use the production process manager for the host. Examples:

```bash
pm2 stop L4_DiscordBot
# or
systemctl stop l4-discordbot
```

Confirm no bot process is still running before copying data.

### 2. Back up SQLite and attachment files

Back up every configured profile file. With the default production profile these are under `data/production/`:

- `l4discord.sqlite`
- `ticket.db`
- `message.db`
- `message_attachment_store.db`
- `vc_time.db`
- `AI_History.db`
- `Automoderation.db`
- `reminder.db`
- `message_log_attachments/`

Example:

```bash
stamp="$(date +%Y%m%d-%H%M%S)"
mkdir -p "backups/sqlite-$stamp"
cp -a data/production/*.db data/production/*.sqlite "backups/sqlite-$stamp"/
cp -a data/production/message_log_attachments "backups/sqlite-$stamp"/
```

Adjust paths if `PRODUCTION_*_PATH` overrides are used.

### 3. Copy data to PostgreSQL

Run from the repository root with the same environment that production uses:

```bash
BOT_PROFILE=production npm run migrate:sqlite-to-postgres
```

The copy script:

- creates all canonical PostgreSQL schemas before copying data
- records PostgreSQL schema versions in `postgres_schema_migrations`
- copies all non-FTS SQLite tables
- recreates SQLite indexes where they can be inferred
- preserves Discord Snowflake IDs as text
- resets identity sequences for integer `id` columns

`message_logs_fts` and FTS shadow tables are intentionally skipped. Current message-log search uses SQL predicates
instead of requiring the SQLite FTS tables.

### 4. Verify copied data

Run:

```bash
BOT_PROFILE=production npm run verify:postgres-data
```

The verifier checks:

- row counts for all copied SQLite tables
- primary key nulls and duplicate key shape
- Snowflake value preservation, including per-value occurrence counts
- identity sequence state for integer `id` primary keys
- major references such as ticket replies and message attachments
- open VC sessions
- Pacchi/Senryu history tables

Do not switch runtime if this command reports any failure.

### 5. Enable the PostgreSQL runtime

Set the active profile to PostgreSQL:

```env
BOT_PROFILE=production
PRODUCTION_DATABASE_URL=postgres://l4bot:password@127.0.0.1:5432/l4discord
```

Then start the bot:

```bash
pm2 start L4_DiscordBot
# or
systemctl start l4-discordbot
```

Startup should log `database connection ok (postgres runtime)`.

### 6. Smoke tests

After startup, check the highest-risk write/read paths:

- slash command registration or startup health logs
- Pacchi settings/read-write command and a non-destructive export
- Senryu save/delete path if enabled
- LolWatcher status command or manual scan if enabled
- VC join/leave session write and VC ranking read
- temporary VC restore state after restart if temporary VC is enabled
- message log search/detail/export
- attachment metadata lookup from a logged message
- Game Deals status or a non-destructive admin view
- AI provider settings read/write path
- Modmail ticket create flow using Components v2

Keep the SQLite backup until these smoke tests pass and the bot has run long enough to cover scheduled jobs.

## Rollback

If verification fails before startup, leave the SQLite backups untouched and fix the migration/verifier issue. Rerun
only against a new verification schema; never rerun the SQLite migration against a production schema. Do not start the
new runtime until verification passes.

If smoke tests fail after startup, stop the bot immediately and restore the previous application release against the
same PostgreSQL data. Do not rerun the SQLite migration against production or start the retired SQLite writer.

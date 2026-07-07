# Repository Guidelines

## Project Structure & Module Organization

This repository is a TypeScript Discord bot using `discord.js`, SQLite, and feature-based modules. Main runtime entry points are `bot.ts` and `src/index.ts`. Core infrastructure lives in `src/core`, Discord client setup in `src/bot`, slash command registration and handlers in `src/commands`, component routing in `src/interactions`, and message-prefix handling in `src/message`.

Feature code is grouped under `src/features/<feature>`, for example `senryu`, `reactionRoles`, `gameDeals`, `vc`, `modmail`, and `werewolf`. Database migrations are in `migrations/sqlite`. Background or external helper code is under `workers`, currently including the Japanese analysis worker.

## Build, Test, and Development Commands

- `npm install`: install dependencies from `package-lock.json`.
- `npm run build`: compile TypeScript with `tsc`.
- `npm run typecheck`: run `tsc --noEmit` without writing build output.
- `npm run dev`: run the debug profile with `tsx watch src/index.ts` after the senryu spec.
- `npm run dev:utf8`: same as dev, but sets Windows console code page to UTF-8.
- `npm run migrate`: apply SQLite migrations.
- `npm run migrate:debug` / `npm run migrate:prod`: apply migrations for the selected profile.
- `npm run start` or `npm run bot`: start the bot through `bot.ts`.

## Codex Local Tooling

This workspace is set up for Codex-assisted development on Windows. Prefer PowerShell 7 (`pwsh`) for shell work when available. If a newly installed command is not visible in the current shell, refresh PATH from the machine and user environment before retrying.

Use the project `.mise.toml` for the Node runtime. Run commands through mise when version consistency matters, for example `mise exec -- npm run typecheck` or `mise exec -- npx tsx <spec-file>`.

Preferred CLI tools for Codex work:

- `rg`: search text in the repository.
- `fd`: find files by name or extension.
- `jq`: inspect JSON from `gh`, APIs, and package metadata.
- `gh`: inspect GitHub PRs, issues, checks, and Actions logs.
- `docker`: run reproducible PostgreSQL or helper services when needed.
- `psql`: inspect PostgreSQL schemas and migration results.
- `bru`: run Bruno API collections if API checks are added.

If the personal Codex skill `l4-discordbot` is available, use it before making repository-specific changes.

## Coding Style & Naming Conventions

Use TypeScript ES modules and keep imports explicit with `.js` suffixes for local runtime imports. Follow the existing two-space indentation style and prefer small, feature-local helpers over broad shared abstractions. Name test files `*.spec.ts` beside the code they cover. Keep configuration and environment-sensitive logic in `src/core/config.ts` or the relevant feature boundary.

## Testing Guidelines

Tests are plain TypeScript spec files executed with `tsx` and Node assertions. Run targeted tests directly, for example:

```powershell
npx tsx src/features/senryu/senryu.spec.ts
npx tsx src/features/senryu/senryu.worker.spec.ts
```

Add focused specs for bug fixes, especially when behavior depends on database state, Discord custom IDs, parsing, or permissions.

## Commit & Pull Request Guidelines

Recent history uses short, imperative summaries in English or Japanese, sometimes with a `fix:` prefix. Keep commits scoped, for example `fix: persist senryu mute settings` or `ロール付与パネルの編集エラーを修正`.

Pull requests should describe the user-visible behavior change, list tests run, mention migration or environment impacts, and link related issues when available. Include screenshots only for UI or Discord panel changes.

## Security & Configuration Tips

Do not commit `.env`, bot tokens, database files, or generated runtime data. Use `.env.example` for documenting configuration. When adding Discord interactions, validate permissions in handlers even if slash command defaults restrict access.

## Database Development Policy

New features that require persistent storage must be designed and implemented for PostgreSQL first. Do not add new SQLite-only schemas or repositories for new functionality. If legacy SQLite-compatible code must be touched, keep PostgreSQL runtime behavior, migrations, and data migration compatibility in scope.

# PostgreSQL runtime運用

このBotのデータベース実行経路はPostgreSQLだけです。Bot起動時に
`DATABASE_URL`へ接続し、各 `POSTGRES_*_SCHEMA` のスキーマへ起動時マイグレーションを適用します。

## 必須設定

`.env`には少なくとも次を設定します。

- `BOT_PROFILE=production` または `debug`
- `DATABASE_URL`
- Discordの認証情報
- 必要に応じた `POSTGRES_MAIN_SCHEMA` などのスキーマ名

既定のスキーマ名は `main`、`ticket`、`message_log`、
`message_attachment`、`vc_time`、`ai_history`、`automod`、
`reminder` です。添付ファイルの実体は
`MESSAGE_ATTACHMENT_FILES_DIR` に保存し、メタデータはPostgreSQLへ保存します。

## 起動と確認

依存関係を入れた後、次の順で確認します。

```powershell
mise exec -- npm install
mise exec -- npm run typecheck
mise exec -- npm run build
mise exec -- npm test
mise exec -- npm start
```

`npm test` は `docker-compose.test.yml` の一時PostgreSQLを起動し、
PostgreSQLを必須にした全スペックを実行してからコンテナとボリュームを削除します。
個別に同じ検証を実行する場合は `npm run test:postgres` を使います。

起動ログで各スキーマの接続確認と
`Database runtime initialized successfully.` が出ることを確認します。
接続できない場合はBotを起動せず、`DATABASE_URL`とPostgreSQLの稼働状態を確認します。

## データ保護

このリポジトリにはSQLiteの実行経路・移行スクリプト・SQLite DDLはありません。
PostgreSQLの既存データを作り直す移行コマンドもありません。

本番データを確認・変更する場合は、別途バックアップとメンテナンス手順を用意してください。
VPS上に保管している過去のバックアップは、このドキュメントや通常のテストから変更されません。

# PostgreSQLとBotの運用

このBotはデータベースにPostgreSQLを使用します。起動時にデータベースへ接続し、マイグレーション（テーブルなどの構造を更新する処理）を適用してからDiscordへ接続します。SQLiteを使う実行経路はありません。

## Botの接続設定

Botの`.env`は[.env.example](../.env.example)を参照して設定します。データベースの接続先には`DATABASE_URL`を使います。`BOT_PROFILE=production`では`PRODUCTION_DATABASE_URL`、`debug`では`DEBUG_DATABASE_URL`が定義されていると、その値を優先します。Discordのトークンや各種IDなど、Bot自体の必須設定も必要です。

データベース内では、用途ごとにスキーマ（テーブルをまとめる名前空間）を分けます。既定値は次のとおりです。

| 設定 | 既定のスキーマ名 |
| --- | --- |
| `POSTGRES_MAIN_SCHEMA` | `main` |
| `POSTGRES_TICKET_SCHEMA` | `ticket` |
| `POSTGRES_MESSAGE_LOG_SCHEMA` | `message_log` |
| `POSTGRES_MESSAGE_ATTACHMENT_SCHEMA` | `message_attachment` |
| `POSTGRES_VC_TIME_SCHEMA` | `vc_time` |
| `POSTGRES_AI_HISTORY_SCHEMA` | `ai_history` |
| `POSTGRES_AUTOMOD_SCHEMA` | `automod` |
| `POSTGRES_REMINDER_SCHEMA` | `reminder` |

添付ファイルの本体は`MESSAGE_ATTACHMENT_FILES_DIR`に保存し、保存先などの情報をPostgreSQLへ格納します。データベースのバックアップだけでは添付ファイルを復元できないため、ファイルの保存先も別途バックアップしてください。

起動時のスキーマ更新内容は[databaseRuntime.ts](../src/bot/databaseRuntime.ts)で管理しています。起動ログの`Database runtime initialized successfully.`はデータベース初期化の成功を示し、Discord接続の成功とは区別します。

### リンク展開の編集・削除同期

新たに展開したDiscordメッセージの引用と、X・YouTube・Steam・GitHub・TikTok・Instagramのプレビューは、元投稿と展開先の対応を`link_expansion_sources`と`link_expansion_messages`に7日間記録します。本文はこの対応表に保存せず、メッセージIDと変更検出用のハッシュ値を使います。同じデータベースを複数のBotで共有する場合も、BotのIDで記録を分けます。導入前のカードは対応記録がないため同期対象になりません。

リンクを貼ったDiscord投稿を編集すると、登録済みの展開先を上書き編集します。取り除いたリンクの展開先は削除し、追加されたリンクは新たに展開します。元投稿の削除や一括削除でも展開先を削除します。Discord引用では、引用元の編集・削除も反映します。自分自身や互いを参照し続ける循環引用は展開しません。

同期期間は初回登録から7日間で、編集しても延長しません。期限後は同期を終了し、対応記録を定期削除します。表示中のカードは期限だけでは削除しません。起動時と1時間ごとに期限内の元投稿を確認し、停止中の変更や一時的な取得失敗を再処理します。権限不足や一時的なAPI障害は、元投稿の削除とは扱いません。

外部サイト上の投稿の編集・削除は自動監視しません。同期対象はDiscord上の投稿です。元投稿、引用元、展開先のチャンネルでは、Botに閲覧とメッセージ履歴参照の権限が必要です。

## ローカルでの確認

依存関係と検証コマンドは[package.json](../package.json)に定義しています。リポジトリのルートで実行してください。

```sh
mise exec -- npm ci
mise exec -- npm run typecheck
mise exec -- npm run lint
mise exec -- npm run build
mise exec -- npm test
```

`npm test`と`npm run test:postgres`は同じ処理を実行します。[docker-compose.test.yml](../docker-compose.test.yml)で一時的なPostgreSQL 16を起動し、テストを実行したあとテスト用ボリュームを削除します。DockerとDocker Composeが使える環境で実行してください。Goのワーカーテストとバックアップスクリプトのテストは、このコマンドには含まれません。

Botを起動する場合は、接続先と認証情報を確認したうえで次を実行します。起動時に指定したデータベースへマイグレーションが適用されます。

```sh
mise exec -- npm start
```

## Docker Composeの構成

[docker-compose.yml](../docker-compose.yml)の基本サービスは次の2つです。

| サービス | 実行内容 | データの保存先 |
| --- | --- | --- |
| `postgres` | PostgreSQL 16 | 名前付きボリューム`postgres-data` |
| `bot` | Node.js 22のBotとGo製日本語解析ワーカー | ホストから割り当てたディレクトリ |

PostgreSQLのホスト側ポートは既定で`127.0.0.1:5432`のみに割り当てます。`POSTGRES_HOST_PORT`でポートを変更でき、BotからはCompose内部の`postgres:5432`へ接続します。コンテナ起動時の接続確認には`pg_isready`を使いますが、これはBotのテーブルや権限の検証ではありません。

Botのファイルは、ホスト側のデータディレクトリをコンテナ側の`/app/data/production`へバインドマウントして保持します。コンテナを作り直しても、添付ファイルや個人プロンプトはホスト側に残ります。旧添付ファイルの保存先`data/message_log_attachments`も、同名のコンテナ内パスへ読み取り専用で割り当てています。データベースが旧保存先を参照している間は、この割り当てを維持してください。

[Dockerfile](../Dockerfile)は日本語解析ワーカーのバイナリと、動画の映像と音声を結合するFFmpegを同梱します。実行ユーザーは`node`です。`.env`、実データ、データベースのボリュームはイメージに含めません。ワーカーの設定は[日本語解析ワーカーの起動と運用](japanese-worker-deployment.md)を参照してください。

## Compose用環境変数の設定例

Composeへ渡す環境変数と、Botの認証情報（`.env`）は別ファイルに分けて管理できます。機密値を含むファイルは所有者のみ読み書きできる権限（`0600`など）で保護し、Gitへ登録しないでください。

```dotenv
BOT_IMAGE=ghcr.io/<owner>/<image>:<tag>
BOT_ENV_FILE=/path/to/bot/.env
BOT_DATABASE_URL=postgres://<db_user>:<url_encoded_password>@postgres:5432/<db_name>
POSTGRES_PASSWORD=<initial_postgres_password>
POSTGRES_HOST_PORT=5432
BOT_DATA_DIR=./data/production
BOT_LEGACY_ATTACHMENT_DATA_DIR=./data/message_log_attachments
```

`BOT_DATABASE_URL`はBot用ロールとデータベースへ接続するURLです。パスワードに記号を含む場合はURLエンコードしてください。ComposeはこれをBotの`DATABASE_URL`と`PRODUCTION_DATABASE_URL`に設定し、`.env`の同名設定より優先します。

`POSTGRES_PASSWORD`は空のデータ領域を初期化するときの`postgres`ロールのパスワードです。Bot用のロールとデータベースはCompose定義だけでは作成されないため、新規環境では別途作成するか、既存バックアップから復元してください。

## 稼働確認

Composeプロジェクトの状態と直近のログを確認します。

```bash
docker compose --env-file <compose-env-file> ps
docker compose --env-file <compose-env-file> logs --no-color --tail=200 bot postgres
```

データベース初期化のログに加え、`discord gateway ready (clientReady)`が出力されているか確認します。日本語解析ワーカーを有効にしている場合は、Botコンテナ内で`/health`への応答を確認できます。

```bash
docker compose --env-file <compose-env-file> exec -T bot node --input-type=module -e \
  "const r = await fetch('http://127.0.0.1:8787/health'); if (!r.ok) process.exit(1); console.log(await r.text());"
```

ログと稼働確認が成功しても、各機能の動作確認は別途必要です。Discord上で基本コマンド、対象チャンネルの返信、添付ファイルの読み書きを確認してください。

## バックアップと復元

### バックアップ対象

データの保全には、PostgreSQLとファイル領域の両方をバックアップする必要があります。

- **データベース**: `pg_dumpall --globals-only`によるロール定義と、`pg_dump --format=custom`による対象データベースのダンプ。
- **ファイル領域**: `.env`と`BOT_DATA_DIR`（添付ファイルやユーザー別プロンプトを含むディレクトリ）。

リポジトリには参考用のスクリプト（[scripts/postgres-backup.sh](../scripts/postgres-backup.sh)、[scripts/app-data-backup.sh](../scripts/app-data-backup.sh)）とsystemdユニット例（[deploy/systemd/](../deploy/systemd/)）を同梱しています。自分の環境に合わせてパス、対象データベース名、保持世代数、実行ユーザーを調整したうえで利用してください。

バックアップの整合性確認（`sha256sum --check`や`pg_restore --list`）が成功しても、実際に復元できることまでは保証されません。定期的に別環境で復元を検証し、同じホスト内だけでなく別の保管先へも退避することを推奨します。

### 別環境での復元検証

復元の検証は、本番とは別のComposeプロジェクト名と空のボリュームで行います。次の例ではデータベースコンテナだけを起動し、Botのログインやマイグレーションは実行しません。

```bash
set -Eeuo pipefail
export BOT_ENV_FILE=.env.example
export BOT_IMAGE=ghcr.io/<owner>/<image>:<tag>
export BOT_DATABASE_URL=postgres://unused:unused@postgres:5432/unused
export POSTGRES_PASSWORD=<rehearsal_password>
export POSTGRES_HOST_PORT=15432

docker compose -p bot-rehearsal up -d postgres --wait
```

取得したダンプを検証用コンテナへコピーし、ロール定義とデータベースを復元します。`globals.sql`に初期化済みの`postgres`ロール作成文が含まれる場合は除外して流し込みます。

```bash
docker compose -p bot-rehearsal exec -T postgres sh -c \
  "sed '/^CREATE ROLE postgres;\$/d' /tmp/backup/globals.sql | psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres"
docker compose -p bot-rehearsal exec -T postgres \
  pg_restore --exit-on-error --create -U postgres -d postgres /tmp/backup/<db_name>.dump
```

復元後はデータベースとスキーマの所有者、権限、拡張機能、テーブル件数、シーケンス値、無効なインデックス、照合順序を確認します。Botを接続して動作確認すると起動時のマイグレーションで構造やデータが変わる場合があるため、データベースの比較はBotを接続する前に終えてください。検証が終わったら、プロジェクト名を確認したうえで検証用ボリュームを削除します。

```bash
docker compose -p bot-rehearsal down -v
```

本番用のComposeプロジェクトに対して`down -v`を実行すると、データベースの保存領域が削除されるため注意してください。

## 障害時の復旧判断

Botの更新に失敗した場合は、まず新しいBotの稼働状態とログを確認します。旧イメージへ戻す場合も、起動時のマイグレーションが既に適用されているか、旧コードが更新後のスキーマを扱えるかを確かめてください。

データベースの変更を戻す必要がある場合は、Botなどの書き込み元を止め、復元時点と失われる更新内容を特定してから復元します。データベースと添付ファイルは別々に保存されるため、復元後は両者の参照関係も確認し、確認が終わるまでBotを再開しないでください。

PostgreSQLのメジャーバージョンを上げる場合は、データディレクトリの直接コピーではなく、論理バックアップからの復元や`pg_upgrade`など公式に案内されている手順を使います。詳細は[PostgreSQLのバージョン方針](https://www.postgresql.org/support/versioning/)と[PostgreSQL 16へのアップグレード手順](https://www.postgresql.org/docs/16/upgrading.html)を参照してください。

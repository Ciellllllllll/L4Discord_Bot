# PostgreSQLとBotの運用

このBotはPostgreSQLを使用します。
起動時にデータベースへ接続し、マイグレーションを適用してからDiscordへ接続します。
マイグレーションは、テーブルなどの構造を更新する処理です。
SQLiteを使う実行経路はありません。

この文書は、2026年9月27日時点のリポジトリ内の実装と設定に基づきます。
VPS上の稼働状態やバックアップの成否は、この文書の更新時には確認していません。
旧PostgreSQL 14からの移行記録は、末尾の「旧環境からの移行記録」に分けています。

## Botの接続設定

Botの`.env`は[.env.example](../.env.example)を参照して設定します。
データベースの接続先には`DATABASE_URL`を使います。
`BOT_PROFILE=production`では`PRODUCTION_DATABASE_URL`、`debug`では`DEBUG_DATABASE_URL`が定義されていると、その値を優先します。
Discordのトークンや各種IDなど、Bot自体の必須設定も必要です。

データベース内では、用途ごとにスキーマを分けます。
スキーマは、テーブルをまとめる名前空間です。
既定値は次のとおりです。

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

添付ファイルの本体は`MESSAGE_ATTACHMENT_FILES_DIR`、保存先などの情報はPostgreSQLへ格納します。
DBのバックアップだけでは添付ファイルを復元できないため、ファイルの保存先も別途バックアップします。

起動時の更新内容は[databaseRuntime.ts](../src/bot/databaseRuntime.ts)で管理しています。
現行の`main`スキーマには、リンク展開の追跡対応（更新番号23）までのマイグレーションが登録されています。
起動ログの`Database runtime initialized successfully.`はDB初期化の成功を示し、Discord接続の成功とは区別します。

### リンク展開の編集・削除同期

新たに展開したDiscordメッセージの引用と、X・YouTube・Steam・GitHub・TikTok・Instagramのプレビューは、元投稿と展開先の対応を`link_expansion_sources`と`link_expansion_messages`に7日間記録します。本文はこの対応表に保存せず、メッセージIDと変更検出用のハッシュ値を使います。本番BOTとデバッグBOTでDBを共有する場合も、BOTのIDで記録を分けます。導入前のカードは対応記録がないため同期対象になりません。

リンクを貼ったDiscord投稿を編集すると、登録済みの展開先を上書き編集します。取り除いたリンクの展開先は削除し、追加されたリンクは新たに展開します。元投稿の削除・一括削除でも展開先を削除します。Discord引用では、引用元の編集・削除も反映します。自分自身や互いを参照し続ける循環引用は展開しません。

期間は初回登録から7日間で、編集しても延長しません。期限後は同期を終了し、対応記録を定期削除します。表示中のカードは期限だけでは削除しません。起動時と1時間ごとに期限内の元投稿を確認し、停止中の変更や一時的な取得失敗を再処理します。権限不足や一時的なAPI障害を、元投稿の削除とは扱いません。

外部サイト上の投稿の編集・削除は自動監視しません。同期対象はDiscord上の投稿です。
元投稿・引用元・展開先のチャンネルでは、BOTに閲覧とメッセージ履歴参照の権限が必要です。

## ローカルでの確認

依存関係と検証コマンドは[package.json](../package.json)に定義されています。
リポジトリのルートで実行します。

```powershell
mise exec -- npm ci
mise exec -- npm run typecheck
mise exec -- npm run lint
mise exec -- npm run build
mise exec -- npm test
```

`npm test`と`npm run test:postgres`は同じ処理です。
[docker-compose.test.yml](../docker-compose.test.yml)で一時的なPostgreSQL 16を起動し、TypeScriptとJavaScriptのテストを実行します。
DockerとComposeが使える環境で実行してください。
終了処理では、テスト用Composeのボリュームを削除します。
Goのworkerテストとバックアップスクリプトのテストは、このコマンドには含まれません。

Botを起動する場合は、接続先と認証情報を確認したうえで次を実行します。
起動によって指定したDBへマイグレーションが適用されます。

```powershell
mise exec -- npm start
```

## Docker Composeの構成

[docker-compose.yml](../docker-compose.yml)は次の2サービスで構成されています。

| サービス | 実行内容 | データの保存先 |
| --- | --- | --- |
| `postgres` | PostgreSQL 16 | 名前付きボリューム`postgres-data` |
| `bot` | Node.js 22のBotとGo製日本語解析worker | ホストから割り当てたディレクトリ |

PostgreSQLのホスト側ポートは、既定で`127.0.0.1:5432`のみに割り当てます。
`POSTGRES_HOST_PORT`でポートを変更でき、BotからはCompose内部の`postgres:5432`へ接続します。
コンテナ起動時の接続確認には`pg_isready`を使いますが、これはBotのテーブルや権限の検証ではありません。

Botのファイルは、ホスト側の`data/production`をコンテナ側の`/app/data/production`に割り当てて保持します。
この割り当てをバインドマウントと呼びます。
コンテナを作り直しても、添付ファイルや個人プロンプトはホスト側に残ります。
旧添付ファイルの保存先`data/message_log_attachments`も、同名のコンテナ内パスへ読み取り専用で割り当てます。
DBが旧保存先を参照している間は、この割り当てを維持してください。

[Dockerfile](../Dockerfile)は、日本語解析workerのバイナリと、動画の映像と音声を結合するFFmpegを同梱します。
実行ユーザーは`node`です。
`.env`、実データ、DBのボリュームはイメージに含めません。
workerの設定は[日本語解析workerの起動と運用](japanese-worker-deployment.md)を参照してください。

## VPSの設定ファイル

Compose用の値は`/etc/l4discord/l4discord-compose.env`、Botの認証情報は`/opt/L4_DiscordBot/.env`に分けます。
Compose用ファイルはroot所有、権限`0600`で管理します。
値の例を次に示します。
プレースホルダーは実際の値へ置き換えてください。

```dotenv
BOT_IMAGE=ghcr.io/ciellllllllll/l4discord_bot:YOUR_COMMIT_SHA
BOT_ENV_FILE=/opt/L4_DiscordBot/.env
BOT_DATABASE_URL=postgres://l4bot:URL_ENCODED_PASSWORD@postgres:5432/l4discord
POSTGRES_PASSWORD=INITIAL_POSTGRES_PASSWORD
POSTGRES_HOST_PORT=5432
BOT_DATA_DIR=./data/production
BOT_LEGACY_ATTACHMENT_DATA_DIR=./data/message_log_attachments
```

`BOT_DATABASE_URL`は既存のBot用ロールとDBへ接続するURLです。
パスワード中の特殊文字はURLエンコードします。
ComposeはこれをBotの`DATABASE_URL`と`PRODUCTION_DATABASE_URL`に設定し、`.env`の同名設定より優先します。

`POSTGRES_PASSWORD`は空のデータ領域を初期化するときの`postgres`ロールのパスワードです。
Bot用の`l4bot`ロールと`l4discord` DBは、このCompose定義だけでは作成されません。
新規環境では別途作成し、移行環境ではバックアップから復元します。
ロールを復元した後のパスワードは、初期化時の値と異なる場合があります。

## 日常の稼働確認

VPSで次を実行すると、Composeの状態と直近のログを確認できます。
デプロイが作成する`.deploy-bot-image.env`が存在する場合は、イメージ指定の上書きも読み込みます。

```bash
cd /opt/L4_DiscordBot
compose_args=(-p l4discord --env-file /etc/l4discord/l4discord-compose.env)
if [[ -f .deploy-bot-image.env ]]; then
  compose_args+=(--env-file /opt/L4_DiscordBot/.deploy-bot-image.env)
fi
sudo docker compose "${compose_args[@]}" ps
sudo docker compose "${compose_args[@]}" logs --no-color --tail=200 bot postgres
```

DB初期化のログに加えて、`discord gateway ready (clientReady)`を確認します。
workerを有効にしている場合は、同じシェルで次を実行できます。

```bash
sudo docker compose "${compose_args[@]}" exec -T bot node --input-type=module -e \
  "const r = await fetch('http://127.0.0.1:8787/health'); if (!r.ok) process.exit(1); console.log(await r.text());"
```

ログと稼働確認が成功しても、各機能の動作確認は別途必要です。
Discord上の基本コマンド、対象チャンネルの返信、添付ファイルの読み書きを確認してください。

## releaseブランチからのデプロイ

[Deploy release to VPS](../.github/workflows/deploy-release.yml)は、`release`へのpush、または同ブランチでの手動実行で起動します。
コミットを識別するSHAをタグにして、Linux/amd64イメージをGHCRへ公開します。
GHCRはGitHubのコンテナイメージ保存先です。
同じタグが既にあれば、そのイメージを再利用します。

VPSでは次の条件を確認してからBotを更新します。

- systemd版の`l4-discordbot`が`inactive`かつ`masked`であること。
- SSH接続ユーザーが`/opt/L4_DiscordBot`の所有者であること。
- リモートの`release`が対象のSHAから進んでいないこと。
- ComposeのPostgreSQLが起動し、接続確認に成功していること。

デプロイ処理ではVPSのチェックアウトを対象コミットへ合わせ、`.deploy-bot-image.env`に`BOT_IMAGE`を書き込みます。
root専用のCompose設定を直接変更せず、後から読み込むこのファイルでイメージだけを上書きします。
Dockerの操作には`sudo /usr/bin/docker`を使い、実行中の`GITHUB_TOKEN`でGHCRへログインします。

更新するサービスは`bot`だけです。
更新後はDB初期化とDiscord接続のログ、コンテナの稼働状態、再起動回数、致命的なエラーログを検査します。
失敗時に旧イメージへ自動で戻す処理はないため、失敗した段階とDB更新の有無を確認して復旧を判断します。

[Publish Docker image](../.github/workflows/docker-release.yml)は手動実行専用で、VPSへの反映は行いません。
こちらは同じタグが既に存在すると失敗します。

## 日次バックアップ

### 保存内容と保持期間

[scripts/postgres-backup.sh](../scripts/postgres-backup.sh)は、PostgreSQL 16のクライアントで次を保存します。
既定の保存先は`/var/backups/postgresql/l4`です。

| ファイル | 内容 |
| --- | --- |
| `globals.sql` | ロールなど、クラスタ全体の定義 |
| `l4discord.dump` | Bot用DBのカスタム形式のダンプ |
| `kendou_ranking.dump` | 剣道ランキング用DBのカスタム形式のダンプ |
| `SHA256SUMS` | ファイルの破損確認に使うハッシュ値 |

途中結果は`.partial-*`ディレクトリへ保存します。
全ダンプの作成と`pg_restore --list`による一覧取得が成功した後、`backup-YYYYMMDDTHHMMSS+0900`のような名前へ変更します。
その後、成功したバックアップのうち最新30世代を残し、古い分を削除します。
名前の時差部分は実行環境のタイムゾーンによります。

`pg_restore --list`の成功は、実際にDBを復元できたことまでは示しません。
別環境での復元確認を行ってください。
VPS内だけに保存しても、VPSの消失やディスク故障には備えられません。
添付ファイルなどは、このスクリプトの対象外です。

### 配置と接続先

ホストにPostgreSQL 16のクライアントと`postgres`ユーザーがあることを確認し、リポジトリのルートから配置します。

```bash
sudo install -d -m 0700 -o postgres -g postgres /var/backups/postgresql/l4
sudo install -m 0750 -o root -g postgres scripts/postgres-backup.sh /usr/local/sbin/l4-postgresql-backup
sudo install -m 0644 deploy/systemd/l4-postgresql-backup.service /etc/systemd/system/
sudo install -m 0644 deploy/systemd/l4-postgresql-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemd-analyze verify /etc/systemd/system/l4-postgresql-backup.service /etc/systemd/system/l4-postgresql-backup.timer
```

スクリプトの既定の接続先はUnixソケットです。
ComposeのPostgreSQLへ接続する場合は、`/etc/l4discord/postgresql-backup.env`を用意します。

```dotenv
PGHOST=127.0.0.1
PGPORT=5432
PGUSER=postgres
PGPASSFILE=/var/lib/postgresql/.pgpass
```

この設定ファイルはroot所有、グループ`postgres`、権限`0640`とします。
`.pgpass`には復元後の有効なパスワードを登録し、所有者を`postgres`、権限を`0600`とします。
どちらもリポジトリへ保存しません。

### 実行結果と定期実行の確認

```bash
sudo systemctl start l4-postgresql-backup.service
test "$(systemctl show -p Result --value l4-postgresql-backup.service)" = success
systemctl show l4-postgresql-backup.service -p Result -p ExecMainStatus -p ActiveState
sudo journalctl -u l4-postgresql-backup.service -n 100 --no-pager
sudo -u postgres find /var/backups/postgresql/l4 -mindepth 1 -maxdepth 1 -type d -name 'backup-*' -printf '%f\n' | sort

sudo systemctl enable --now l4-postgresql-backup.timer
systemctl list-timers l4-postgresql-backup.timer --no-pager
```

[timer定義](../deploy/systemd/l4-postgresql-backup.timer)では、バックアップを毎日06:00 JSTに実行するよう設定しています。
`Persistent=true`のため、停止中に予定時刻を過ぎた場合は、timerの再開時に未実行分が実行されます。
バックアップの終了状態に加え、保持世代の削除に関する警告もログで確認してください。

## 別環境での復元確認

復元は、本番とは別のComposeプロジェクトと空のボリュームで確認します。
次の例はDBだけを起動し、Botのログインやマイグレーションを行いません。
本番ファイルを読み込まないよう、Bot用環境ファイルには`.env.example`を指定します。

以下の手順は、VPSの同じrootシェル内で続けて実行します。
`YOUR_COMMIT_SHA`と検証用パスワードを置き換え、`l4discord-rehearsal`が既存の作業で使われていないことを確認してください。

```bash
set -Eeuo pipefail
cd /opt/L4_DiscordBot
export BOT_ENV_FILE=.env.example
export BOT_IMAGE=ghcr.io/ciellllllllll/l4discord_bot:YOUR_COMMIT_SHA
export BOT_DATABASE_URL=postgres://unused:unused@postgres:5432/unused
export POSTGRES_PASSWORD=REHEARSAL_ONLY_PASSWORD
export POSTGRES_HOST_PORT=15432

docker compose -p l4discord-rehearsal up -d postgres --wait
existing_databases=$(docker compose -p l4discord-rehearsal exec -T postgres \
  psql -X -A -t -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -c "SELECT count(*) FROM pg_database WHERE datname NOT IN ('postgres','template0','template1');")
test "$existing_databases" = 0
snapshot=$(
  find /var/backups/postgresql/l4 -regextype posix-extended \
    -mindepth 1 -maxdepth 1 -type d \
    -regex '.*/backup-[0-9]{8}T[0-9]{6}[+-][0-9]{4}' -printf '%p\n' |
    sort -r | sed -n '1p'
)
test -n "$snapshot"
(cd "$snapshot" && sha256sum --check SHA256SUMS)

postgres_container=$(docker compose -p l4discord-rehearsal ps -q postgres)
test -n "$postgres_container"
docker cp "$snapshot" "$postgres_container:/tmp/"
restore_dir="/tmp/$(basename "$snapshot")"
docker exec --user root "$postgres_container" chown -R postgres:postgres "$restore_dir"

docker compose -p l4discord-rehearsal exec -T postgres sh -c \
  "test \"\$(grep -xc 'CREATE ROLE postgres;' '$restore_dir/globals.sql')\" -eq 1"
docker compose -p l4discord-rehearsal exec -T postgres sh -c \
  "sed '/^CREATE ROLE postgres;\$/d' '$restore_dir/globals.sql' | psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres"
for database in l4discord kendou_ranking; do
  docker compose -p l4discord-rehearsal exec -T postgres \
    pg_restore --exit-on-error --create -U postgres -d postgres "$restore_dir/$database.dump"
done
```

`globals.sql`にある`CREATE ROLE postgres;`は、初期化済みのロールと重複します。
この行が1件あることを確認して除外します。
それ以外のSQLエラーが起きた場合は処理を停止します。
DBは`pg_restore --create`で作成し、DB自体の権限や設定も復元します。
追加のテーブルスペースなどがある環境では、復元先にも対応する保存先を準備する必要があります。

復元後は、バックアップ取得時に保存した一覧と比較します。
比較する対象はDBとスキーマの所有者、権限、拡張機能、テーブル件数、シーケンスの値、無効なインデックス、照合順序です。
稼働中の本番DBは更新され続けるため、後から取得した件数との不一致だけでは復元失敗と判断できません。

復元結果を確認する基本のSQLを示します。
続くループで、各DBの所有者、権限、テーブル件数、シーケンスの値も取得します。

```bash
docker compose -p l4discord-rehearsal exec -T postgres \
  psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'
SELECT datname, pg_get_userbyid(datdba) AS owner, datacl
FROM pg_database
WHERE datname IN ('l4discord', 'kendou_ranking')
ORDER BY datname;
SELECT datname, datcollversion, pg_database_collation_actual_version(oid) AS actual
FROM pg_database
WHERE datallowconn
  AND datcollversion IS DISTINCT FROM pg_database_collation_actual_version(oid);
SQL

for database in l4discord kendou_ranking; do
  docker compose -p l4discord-rehearsal exec -T postgres \
    psql -X -A -t -F '|' -v ON_ERROR_STOP=1 -U postgres -d "$database" <<'SQL'
SELECT 'extension', extname, extversion FROM pg_extension ORDER BY extname;
SELECT 'schema', nspname, pg_get_userbyid(nspowner), nspacl
FROM pg_namespace
WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'
ORDER BY nspname;
SELECT 'object', n.nspname, c.relkind, c.relname, pg_get_userbyid(c.relowner), c.relacl
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
ORDER BY n.nspname, c.relkind, c.relname;
SELECT format('SELECT %L, count(*) FROM %I.%I;',
  'row_count|' || n.nspname || '.' || c.relname, n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r','p') AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
ORDER BY n.nspname, c.relname
\gexec
SELECT format('SELECT %L, last_value, is_called FROM %I.%I;',
  'sequence|' || n.nspname || '.' || c.relname, n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'S' AND n.nspname !~ '^pg_'
ORDER BY n.nspname, c.relname
\gexec
SELECT 'invalid_index', n.nspname, c.relname
FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE NOT i.indisvalid
ORDER BY n.nspname, c.relname;
SQL
done
```

Botで復元DBを検証すると、起動時にマイグレーションが適用され、比較対象の構造やデータが変わる場合があります。
DBの比較を先に終え、Botの確認には専用のDiscord認証情報と、本番から分離したファイル保存先を用意します。

検証データが不要になったら、使用したプロジェクト名を確認してリハーサル用のボリュームだけを削除します。
本番の`l4discord`に対して`down -v`を実行すると、DBの保存領域が削除されます。

```bash
docker compose -p l4discord-rehearsal down -v
```

## 障害時の復旧判断

Botの更新に失敗した場合は、まず新しいBotの稼働状態とログを確認します。
旧イメージへ戻す場合も、起動時のマイグレーションが既に適用されたか、旧コードが更新後のDBを扱えるかを確認します。
DBの変更を戻す必要がある場合は、Botなどの書き込み元を止め、復元時点と失われる更新を特定してから復元します。

DBと添付ファイルは別々に保存されるため、復元後は両者の参照関係も確認します。
既存データを削除する操作や本番DBの復元は、対象と復元時点を確認し、明示承認を得て実施します。
復元確認が完了するまでBotを再開しません。

## 旧環境からの移行記録

従来の文書には、Ubuntu 22.04 LTS上のPostgreSQL 14クラスタ`14/main`と`l4-discordbot.service`から、ComposeのPostgreSQL 16とBotへ移行した記録があります。
関連するDBは`l4discord`と`kendou_ranking`、関連サービスは`kendou-ranking.service`です。
旧クラスタやサービスが現在も残っているかは、VPSで確認する必要があります。

当時の計画では、停止時間を04:00〜04:30 JST、切り戻し判断を停止から20分としていました。
移行後の旧クラスタは比較用に7日間保持し、復元確認と削除承認の後に廃止する方針でした。
この時間枠や保持期間は過去の計画であり、現在の保守作業へそのまま適用する条件ではありません。

再びメジャーバージョンを移行する場合は、停止、最終バックアップ、空の移行先への復元、DBとファイルの比較、アプリケーション確認の順で計画します。
新しいDBへアプリケーションが書き込む前なら旧環境への再接続を検討できますが、書き込み後は更新内容の扱いを決める必要があります。
古いクラスタを起動するだけでは、その間の更新は引き継がれません。

PostgreSQL 14のサポート終了予定日は2026年11月12日です。
メジャーバージョン間では、データディレクトリの直接コピーで移行せず、論理バックアップからの復元など、対応する方法を使います。
詳細は[PostgreSQLのサポート方針](https://www.postgresql.org/support/versioning/)と[PostgreSQL 16への更新手順](https://www.postgresql.org/docs/16/upgrading.html)を参照してください。

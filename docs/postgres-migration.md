# PostgreSQL runtime運用

このBotのデータベース実行経路はPostgreSQLだけです。Bot起動時に
`DATABASE_URL`へ接続し、各`POSTGRES_*_SCHEMA`へ起動時マイグレーションを適用します。

## 必須設定と通常確認

`.env`には少なくとも次を設定します。

- `BOT_PROFILE=production`または`debug`
- `DATABASE_URL`
- Discordの認証情報
- 必要に応じた`POSTGRES_MAIN_SCHEMA`などのスキーマ名

既定のスキーマ名は`main`、`ticket`、`message_log`、
`message_attachment`、`vc_time`、`ai_history`、`automod`、`reminder`です。
添付ファイル本体は`MESSAGE_ATTACHMENT_FILES_DIR`、メタデータはPostgreSQLへ保存します。

```powershell
mise exec -- npm install
mise exec -- npm run typecheck
mise exec -- npm run build
mise exec -- npm test
mise exec -- npm start
```

`npm test`は`docker-compose.test.yml`の一時PostgreSQL 16を使います。
起動ログで`Database runtime initialized successfully.`を確認してください。

## Docker Compose構成

本番BotはDocker Composeで運用します。systemd版Botは停止・無効化済みです。以下の切り替え手順は、再移行や復旧が必要になった場合の手順として残しています。

本番Composeは次の2サービスだけで構成します。

- `bot`: Node.js 22の実行イメージ。Go製日本語workerを子プロセスとして内蔵します。
- `postgres`: `postgres:16`。データは`postgres-data`という名前付きvolumeに保存します。

PostgreSQLはインターネットへ公開しません。既存のsystemdサービスとバックアップを切り替え期間中も
接続できるよう、Composeでは`127.0.0.1:5432`だけへバインドし、Bot自身は内部の`postgres:5432`へ接続します。
Botのファイル状態（添付ファイル、ADHD動画、個人プロンプト、その他のproduction状態）は、
ホストの`data/production`を`/app/data/production`へbind mountして保持します。
旧DBが参照する`data/message_log_attachments`も、移行完了までは
`/app/data/message_log_attachments`へ読み取り専用で追加bind mountして保持します。
`.env`、`data`、DB volumeはDockerイメージへコピーしません。

`release`ブランチへのpushでは、GitHub Actionsの`Deploy release to VPS`がコミットSHA付きの
DockerイメージをGHCRへ公開し、そのままVPSのCompose Botだけを更新します。タグはコミットSHAだけを使います。
`Publish Docker image`は手動実行専用で、自動デプロイとは別にイメージを公開したい場合だけ使います。
ActionsはVPS上の`/etc/l4discord/l4discord-compose.env`をComposeの`--env-file`として使います。
このファイルには`BOT_IMAGE`、`BOT_DATABASE_URL`、`POSTGRES_PASSWORD`などのCompose設定を置き、
BotのDiscordトークンなどは別の`/opt/L4_DiscordBot/.env`へ置きます。ActionsがComposeへ渡すのは`BOT_IMAGE`だけです。
このCompose用ファイルはroot所有・`0600`で作成します。GitHub Actionsの`VPS_USER`は`/opt/L4_DiscordBot`の所有者とし、
パスワードなしの`sudo`は`/usr/bin/docker`だけに許可します。Actionsはroot専用ファイルを直接読み書きせず、
`/opt/L4_DiscordBot/.deploy-bot-image.env`を作成して`BOT_IMAGE`だけをComposeへ上書きで渡します。

## 本番環境

- OS: Ubuntu 22.04 LTS
- SSH alias: `kagoya-root`
- 本番クラスタ: Docker Composeの`postgres:16`、Compose内部5432
- 旧クラスタ: PostgreSQL 14 `14/main`、停止・切り戻し用
- DB: `l4discord`（所有者`l4bot`）、`kendou_ranking`（所有者`kendou_ranking_app`）
- 本番Bot: Docker Composeプロジェクト`l4discord`の`bot`
- 旧Bot: `l4-discordbot.service`、停止・無効化・mask済み
- アプリ: `kendou-ranking.service`
- 停止枠: 04:00〜04:30 JST
- 切り戻し判断: 停止から20分

PostgreSQL 14のサポートは2026年11月12日までです。
移行にはPostgreSQLの論理バックアップ／復元を使います。PostgreSQL 14のデータディレクトリを
PostgreSQL 16のvolumeへ直接コピーしません。

- [PostgreSQL versioning policy](https://www.postgresql.org/support/versioning/)
- [PostgreSQL major-version upgrade](https://www.postgresql.org/docs/16/upgrading.html)

## 日次バックアップ

### 配置

リポジトリの主チェックアウトで検証後、VPSへ配置します。

```bash
sudo install -d -m 0700 -o postgres -g postgres /var/backups/postgresql/l4
sudo install -m 0750 -o root -g postgres scripts/postgres-backup.sh /usr/local/sbin/l4-postgresql-backup
sudo install -m 0644 deploy/systemd/l4-postgresql-backup.service /etc/systemd/system/
sudo install -m 0644 deploy/systemd/l4-postgresql-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemd-analyze verify /etc/systemd/system/l4-postgresql-backup.service /etc/systemd/system/l4-postgresql-backup.timer
```

バックアップはPostgreSQL 16のクライアントを使用し、次を保存します。

- `globals.sql`: DBロールと権限
- `l4discord.dump`: Bot DBのcustom-formatダンプ
- `kendou_ranking.dump`: 剣道ランキングDBのcustom-formatダンプ
- `SHA256SUMS`: 破損確認用ハッシュ

途中結果は同じ保存先の`.partial-*`へ作成します。全ダンプと
`pg_restore --list`が成功した後だけ`backup-YYYYMMDDTHHMMSS+0900`へ変更し、
その後に限り成功済みの最新30世代を超えた分を削除します。

### 手動実行と定期実行

```bash
sudo systemctl start l4-postgresql-backup.service
test "$(systemctl show -p Result --value l4-postgresql-backup.service)" = success
systemctl show l4-postgresql-backup.service -p Result -p ExecMainStatus -p ActiveState
sudo journalctl -u l4-postgresql-backup.service -n 100 --no-pager
sudo -u postgres find /var/backups/postgresql/l4 -mindepth 1 -maxdepth 1 -type d -name 'backup-*' -printf '%f\n' | sort

sudo systemctl enable --now l4-postgresql-backup.timer
systemctl list-timers l4-postgresql-backup.timer --no-pager
```

timerは毎日06:00 JSTに実行します。VPS内だけの保存なので、DBの誤操作には使えますが、
VPS削除やディスク故障には対応できません。

## 復元リハーサル

リハーサルでは本番Composeプロジェクトと別のプロジェクト名・volumeを使います。
本番の`postgres-data`や本番Botを使わず、リハーサル終了後にリハーサルvolumeだけを削除します。
以下は同じシェルで実行してください。

```bash
set -Eeuo pipefail
cd /opt/L4_DiscordBot
export BOT_ENV_FILE=.env
export BOT_IMAGE=ghcr.io/ciellllllllll/l4discord_bot:YOUR_COMMIT_SHA
export BOT_DATABASE_URL=postgres://l4bot:EXISTING_L4BOT_PASSWORD@postgres:5432/l4discord
export POSTGRES_PASSWORD=REHEARSAL_ONLY_PASSWORD
export POSTGRES_HOST_PORT=15432
export BOT_DATA_DIR=/tmp/l4discord-rehearsal-data
mkdir -p "$BOT_DATA_DIR"
docker compose -p l4discord-rehearsal up -d postgres --wait

snapshot=$(
  sudo -u postgres find /var/backups/postgresql/l4 -regextype posix-extended \
    -mindepth 1 -maxdepth 1 -type d \
    -regex '.*/backup-[0-9]{8}T[0-9]{6}[+-][0-9]{4}' -printf '%p\n' |
    sort -r | sed -n '1p'
)
test -n "$snapshot"
sudo -u postgres sh -c "cd '$snapshot' && sha256sum --check SHA256SUMS"

postgres_container=$(docker compose -p l4discord-rehearsal ps -q postgres)
test -n "$postgres_container"
docker cp "$snapshot" "$postgres_container:/tmp/"
restore_dir="/tmp/$(basename "$snapshot")"
docker exec --user root "$postgres_container" chown -R postgres:postgres "$restore_dir"
docker compose -p l4discord-rehearsal exec -T postgres sh -c \
  "test \"\$(grep -xc 'CREATE ROLE postgres;' '$restore_dir/globals.sql')\" -eq 1"
docker compose -p l4discord-rehearsal exec -T postgres sh -c \
  "sed '/^CREATE ROLE postgres;\$/d' '$restore_dir/globals.sql' | psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres"
docker compose -p l4discord-rehearsal exec -T postgres \
  pg_restore --exit-on-error --create -U postgres -d postgres "$restore_dir/l4discord.dump"
docker compose -p l4discord-rehearsal exec -T postgres \
  pg_restore --exit-on-error --create -U postgres -d postgres "$restore_dir/kendou_ranking.dump"

docker compose -p l4discord-rehearsal exec -T postgres psql -X -A -t -F '|' -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'
SELECT 'database', datname, pg_get_userbyid(datdba)
FROM pg_database
WHERE datname IN ('l4discord','kendou_ranking')
ORDER BY datname;
SQL

for database in l4discord kendou_ranking; do
  docker compose -p l4discord-rehearsal exec -T postgres psql -X -A -t -F '|' -v ON_ERROR_STOP=1 -U postgres -d "$database" <<'SQL'
SELECT 'extension', extname, extversion FROM pg_extension ORDER BY extname;
SELECT 'schema', nspname, pg_get_userbyid(nspowner)
FROM pg_namespace
WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'
ORDER BY nspname;
SELECT format(
  'SELECT %L, count(*) FROM %I.%I;',
  'row_count|' || n.nspname || '.' || c.relname,
  n.nspname,
  c.relname
)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r','p')
  AND n.nspname !~ '^pg_'
  AND n.nspname <> 'information_schema'
ORDER BY n.nspname, c.relname
\gexec
SQL
done

set +e
docker compose -p l4discord-rehearsal run --rm \
  -e DISCORD_TOKEN=REHEARSAL_INVALID_TOKEN \
  -e PRODUCTION_DISCORD_TOKEN=REHEARSAL_INVALID_TOKEN \
  bot \
  >/tmp/l4discord-rehearsal-bot.log 2>&1
bot_status=$?
set -e
grep -q 'Database runtime initialized successfully\.' /tmp/l4discord-rehearsal-bot.log
test "$bot_status" -ne 0
rm -rf -- "$BOT_DATA_DIR"

docker compose -p l4discord-rehearsal exec -T postgres rm -rf "$restore_dir"
```

`pg_dumpall`は既存のbootstrap roleである`postgres`にも`CREATE ROLE postgres;`を出力するため、
その1行だけが正確に1件あることを検査して除外します。その他のエラーは
`ON_ERROR_STOP`で停止します。DBは`pg_restore --create`で作成し、DB自身の権限・コメント・設定も復元します。

復元後、前項のインベントリを本番PG14とリハーサルComposeの両方から採取し、
スキーマ、所有者、権限、主要テーブル件数、シーケンス、無効インデックスが一致することを確認します。
確認後にリハーサルだけを削除します。本番volumeを指定した`down -v`は禁止です。

```bash
docker compose -p l4discord-rehearsal down -v
```

## DBインベントリの採取

次の関数をVPSのrootシェルへ貼り付け、移行前後で同じ結果を保存します。
第2引数を省略するとUnixソケット、第3引数を省略すると5432へ接続します。

```bash
collect_inventory() {
  output_dir=$1
  host=${2:-/var/run/postgresql}
  port=${3:-5432}
  install -d -m 0700 "$output_dir"

  sudo -u postgres psql -X -A -t -F '|' -v ON_ERROR_STOP=1 --host="$host" --port="$port" -d postgres >"$output_dir/databases.txt" <<'SQL' || return 1
SELECT 'database', datname, pg_get_userbyid(datdba),
       COALESCE(datacl, acldefault('d', datdba)),
       obj_description(oid, 'pg_database')
FROM pg_database
WHERE datname IN ('l4discord','kendou_ranking')
ORDER BY datname;
SELECT 'database_setting', COALESCE(d.datname, '*'), COALESCE(r.rolname, '*'), unnest(s.setconfig)
FROM pg_db_role_setting s
LEFT JOIN pg_database d ON d.oid = s.setdatabase
LEFT JOIN pg_roles r ON r.oid = s.setrole
WHERE d.datname IN ('l4discord','kendou_ranking') OR s.setdatabase = 0
ORDER BY 2, 3, 4;
SQL

  for database in l4discord kendou_ranking; do
    sudo -u postgres psql -X -A -t -F '|' -v ON_ERROR_STOP=1 --host="$host" --port="$port" -d "$database" >"$output_dir/$database.txt" <<'SQL' || return 1
SELECT 'extension', extname, extversion FROM pg_extension ORDER BY extname;
SELECT 'schema', nspname, pg_get_userbyid(nspowner), nspacl
FROM pg_namespace
WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'
ORDER BY nspname;
SELECT 'object', n.nspname, c.relkind, c.relname, pg_get_userbyid(c.relowner), c.relacl
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
ORDER BY n.nspname, c.relkind, c.relname;
SELECT format(
  'SELECT %L, count(*) FROM %I.%I;',
  'row_count|' || n.nspname || '.' || c.relname,
  n.nspname,
  c.relname
)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r','p')
  AND n.nspname !~ '^pg_'
  AND n.nspname <> 'information_schema'
ORDER BY n.nspname, c.relname
\gexec
SELECT format(
  'SELECT %L, last_value, is_called FROM %I.%I;',
  'sequence|' || n.nspname || '.' || c.relname,
  n.nspname,
  c.relname
)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'S'
  AND n.nspname !~ '^pg_'
ORDER BY n.nspname, c.relname
\gexec
SELECT 'invalid_index', schemaname, indexname
FROM pg_indexes i
JOIN pg_class c ON c.relname = i.indexname
JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = i.schemaname
JOIN pg_index x ON x.indexrelid = c.oid
WHERE NOT x.indisvalid
ORDER BY schemaname, indexname;
SQL
  done
}
```

使用例です。

```bash
collect_inventory /root/postgres-inventory-before || exit 1
# リハーサルでは、上記のCompose内SQL出力と本番PG14の保存結果を比較します。
# 本番切替時は、Compose用の同じSQLを /root/postgres-inventory-after-docker へ保存します。
```
## Docker Compose事前準備

DockerのVPSへのインストールは今回行いません。DockerとComposeが利用できる状態になってから、
停止時間より前に次を実行します。

```bash
set -Eeuo pipefail
cd /opt/L4_DiscordBot
compose_env=/etc/l4discord/l4discord-compose.env
sudo test -r "$compose_env"
sudo test -f /opt/L4_DiscordBot/.env
sudo install -d -m 0750 -o 1000 -g 1000 /opt/L4_DiscordBot/data/production
sudo docker compose -p l4discord --env-file "$compose_env" config --quiet
sudo docker compose -p l4discord --env-file "$compose_env" pull postgres bot
sudo docker compose -p l4discord --env-file "$compose_env" run --rm --no-deps bot node --version
```

`/etc/l4discord/l4discord-compose.env`には少なくとも次を設定します。`POSTGRES_PASSWORD`はCompose初回起動時のbootstrap用
`postgres`ロールのパスワード、`BOT_DATABASE_URL`は復元した既存`l4bot`ロールの接続URLです。
論理復元で`l4bot`のパスワードも戻るため、後者は実際の既存パスワードをURLエンコードして指定します。
初回作成時はrootで次を実行してから、rootだけが読める状態で値を入力します。

```bash
sudo install -d -m 0750 /etc/l4discord
sudo touch /etc/l4discord/l4discord-compose.env
sudo chown root:root /etc/l4discord/l4discord-compose.env
sudo chmod 0600 /etc/l4discord/l4discord-compose.env
sudoedit /etc/l4discord/l4discord-compose.env
```

```dotenv
BOT_IMAGE=ghcr.io/ciellllllllll/l4discord_bot:YOUR_COMMIT_SHA
BOT_ENV_FILE=/opt/L4_DiscordBot/.env
BOT_DATABASE_URL=postgres://l4bot:EXISTING_L4BOT_PASSWORD@postgres:5432/l4discord
POSTGRES_PASSWORD=COMPOSE_POSTGRES_PASSWORD
POSTGRES_HOST_PORT=5432
BOT_DATA_DIR=./data/production
BOT_LEGACY_ATTACHMENT_DATA_DIR=./data/message_log_attachments
```

`/opt/L4_DiscordBot/.env`にはDiscordトークンなどBot実行時の秘密情報を設定します。
Actionsはこのroot専用ファイルを変更せず、同じディレクトリの`.deploy-bot-image.env`へ`BOT_IMAGE`だけを書き込みます。
このファイルには秘密情報を置きません。

GHCRが非公開の場合は、VPSのroot Dockerへパッケージ読み取り権限を持つデプロイトークンで
`sudo docker login ghcr.io`を行います。トークンは`.env`やリポジトリへ保存しません。Deploy workflowはこの手動ログインとは別に、
実行中の`GITHUB_TOKEN`でVPSのroot Dockerへログインしてからイメージを取得します。

`BOT_DATABASE_URL`のホスト名は`postgres`にします。Composeは既存`.env`に残った
`PRODUCTION_DATABASE_URL`や永続パス設定を上書きし、コンテナ内の接続先と
`/app/data/production`配下の保存先を使用します。workerのユーザー辞書を使う場合は、
ホストのパスではなく`/app/data/production/...`を`JAPANESE_WORKER_USER_DICT_PATH`へ設定します。

`release`ブランチへのpushで`Deploy release to VPS`がGHCRへLinux/amd64イメージを公開し、同じコミットSHAの
イメージをVPSへ反映します。`Publish Docker image` workflowは手動実行専用です。`latest`のような上書きタグは使いません。
`Deploy release to VPS`は実行ごとにActionsの`GITHUB_TOKEN`でVPSのroot DockerへGHCRログインしてから、
`.deploy-bot-image.env`を使ってイメージを取得します。VPSへの`sudo`はDocker操作にだけ使います。
ActionsはsystemdのBotがinactiveかつmaskedであることも確認します。systemdへ戻す場合だけ、先にComposeのbotを停止し、
明示的に`systemctl unmask`してsystemd版を起動します。Docker運用へ戻す前にはsystemd版を停止・disable・maskへ戻します。

バックアップserviceは、切り替え前はPostgreSQL 14のUnixソケットを使います。切り替え後に
ComposeのPostgreSQL 16へ向ける場合だけ、`/etc/l4discord/postgresql-backup.env`へ次を設定し、
`postgres`ユーザーが読める`.pgpass`へ復元後の`postgres`ロールの有効なパスワードを登録します。
`POSTGRES_PASSWORD`は初回起動時の値であり、globals復元後のパスワードと同じとは限りません。

```dotenv
PGHOST=127.0.0.1
PGPORT=5432
PGUSER=postgres
PGPASSFILE=/var/lib/postgresql/.pgpass
```

このファイルと`.pgpass`はリポジトリへ保存せず、VPS上でrootが作成します。

## Docker Compose本番切替

次の操作は同じrootログインシェルで行います。collect_inventoryはこの文書の前項を先に定義してください。
DB移行とBot起動の確認を分け、DBが合格するまでBotを起動しません。

~~~bash
sudo -i
set -Eeuo pipefail
cd /opt/L4_DiscordBot
project=l4discord
maintenance_started=$(date +%s)
~~~

### 04:00 停止と最終バックアップ

~~~bash
sudo systemctl stop l4-postgresql-backup.timer
sudo systemctl stop l4-discordbot kendou-ranking
if sudo systemctl is-active --quiet l4-discordbot; then
  echo 'old systemd Bot is still active; do not start Compose Bot' >&2
  exit 1
fi

active_clients=$(sudo -u postgres psql -X -A -t -v ON_ERROR_STOP=1 -d postgres -c \
  "SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid();")
test "$active_clients" = 0

sudo systemctl start l4-postgresql-backup.service
test "$(systemctl show -p Result --value l4-postgresql-backup.service)" = success
systemctl show l4-postgresql-backup.service -p Result -p ExecMainStatus -p ActiveState

snapshot=$(
  sudo -u postgres find /var/backups/postgresql/l4 -regextype posix-extended \
    -mindepth 1 -maxdepth 1 -type d \
    -regex '.*/backup-[0-9]{8}T[0-9]{6}[+-][0-9]{4}' -printf '%p\n' |
    sort -r | sed -n '1p'
)
test -n "$snapshot"
sudo -u postgres sh -c "cd '$snapshot' && sha256sum --check SHA256SUMS"
printf '%s\n' "$snapshot" >/root/l4-pre-cutover-snapshot
chmod 0600 /root/l4-pre-cutover-snapshot
collect_inventory /root/postgres-inventory-before || exit 1
(cd /opt/L4_DiscordBot && find data/production -type f -print0 | sort -z | xargs -0 -r sha256sum) \
  >/root/data-production-before.sha256
sudo chown -R 1000:1000 /opt/L4_DiscordBot/data/production
~~~

想定外のDB接続が残っていた場合、強制終了せず中止します。バックアップまたはインベントリ採取が
失敗した場合もPG14を変更せず、systemd Botとtimerを戻して延期します。

### 新しいPostgreSQL 16への復元

~~~bash
sudo systemctl stop postgresql@14-main
if sudo systemctl is-active --quiet postgresql@14-main; then
  echo 'PostgreSQL 14 is still active; do not start Compose PostgreSQL' >&2
  exit 1
fi
docker compose -p "$project" up -d postgres --wait

empty_checks=$(docker compose -p "$project" exec -T postgres psql -X -A -t -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'
SELECT count(*) FROM pg_database WHERE datname NOT IN ('postgres','template0','template1');
SELECT count(*) FROM pg_roles WHERE rolname <> 'postgres' AND rolname !~ '^pg_';
SELECT count(*) FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema','public') AND nspname !~ '^pg_toast';
SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname NOT IN ('pg_catalog','information_schema','public') AND n.nspname !~ '^pg_toast';
SELECT count(*) FROM pg_tablespace WHERE spcname NOT IN ('pg_default','pg_global');
SQL
)
test "$empty_checks" = $'0\n0\n0\n0\n0'

postgres_container=$(docker compose -p "$project" ps -q postgres)
test -n "$postgres_container"
docker cp "$snapshot" "$postgres_container:/tmp/"
restore_dir="/tmp/$(basename "$snapshot")"
docker exec --user root "$postgres_container" chown -R postgres:postgres "$restore_dir"
docker compose -p "$project" exec -T postgres sh -c \
  "test \"\$(grep -xc 'CREATE ROLE postgres;' '$restore_dir/globals.sql')\" -eq 1"
docker compose -p "$project" exec -T postgres sh -c \
  "sed '/^CREATE ROLE postgres;$/d' '$restore_dir/globals.sql' | psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres"
docker compose -p "$project" exec -T postgres \
  pg_restore --exit-on-error --create -U postgres -d postgres "$restore_dir/l4discord.dump"
docker compose -p "$project" exec -T postgres \
  pg_restore --exit-on-error --create -U postgres -d postgres "$restore_dir/kendou_ranking.dump"
docker compose -p "$project" exec -T postgres rm -rf "$restore_dir"
~~~

postgres-dataに既存DBやオブジェクトがあった場合は、上の5検査が0にならないため中止します。
既存volumeを削除して続行してはいけません。原因を確認してから、別名の検証プロジェクトで再実施します。

### DB移行の合否判定

~~~bash
elapsed=$(( $(date +%s) - maintenance_started ))
(( elapsed < 1200 )) || { echo '04:20 cutoff reached; do not start applications' >&2; exit 1; }

docker compose -p "$project" exec -T postgres psql -X -U postgres -d postgres -c 'SELECT version();'
collation_mismatches=$(docker compose -p "$project" exec -T postgres psql -X -A -t -U postgres -d postgres -c \
  "SELECT datname, datcollversion, pg_database_collation_actual_version(oid) AS actual FROM pg_database WHERE datallowconn AND datcollversion IS DISTINCT FROM pg_database_collation_actual_version(oid);")
test -z "$collation_mismatches"

mkdir -p /root/postgres-inventory-after-docker
docker compose -p "$project" exec -T postgres psql -X -A -t -F '|' -v ON_ERROR_STOP=1 -U postgres -d postgres \
  >/root/postgres-inventory-after-docker/databases.txt <<'SQL'
SELECT 'database', datname, pg_get_userbyid(datdba),
       COALESCE(datacl, acldefault('d', datdba)), obj_description(oid, 'pg_database')
FROM pg_database WHERE datname IN ('l4discord','kendou_ranking') ORDER BY datname;
SELECT 'database_setting', COALESCE(d.datname, '*'), COALESCE(r.rolname, '*'), unnest(s.setconfig)
FROM pg_db_role_setting s
LEFT JOIN pg_database d ON d.oid = s.setdatabase
LEFT JOIN pg_roles r ON r.oid = s.setrole
WHERE d.datname IN ('l4discord','kendou_ranking') OR s.setdatabase = 0
ORDER BY 2, 3, 4;
SQL

for database in l4discord kendou_ranking; do
  docker compose -p "$project" exec -T postgres psql -X -A -t -F '|' -v ON_ERROR_STOP=1 -U postgres -d "$database" \
    >"/root/postgres-inventory-after-docker/$database.txt" <<'SQL'
SELECT 'extension', extname, extversion FROM pg_extension ORDER BY extname;
SELECT 'schema', nspname, pg_get_userbyid(nspowner), nspacl
FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema' ORDER BY nspname;
SELECT 'object', n.nspname, c.relkind, c.relname, pg_get_userbyid(c.relowner), c.relacl
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname !~ '^pg_' AND nspname <> 'information_schema'
ORDER BY n.nspname, c.relkind, c.relname;
SELECT format('SELECT %L, count(*) FROM %I.%I;', 'row_count|' || n.nspname || '.' || c.relname, n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r','p') AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
ORDER BY n.nspname, c.relname
\gexec
SELECT format('SELECT %L, last_value, is_called FROM %I.%I;', 'sequence|' || n.nspname || '.' || c.relname, n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'S' AND n.nspname !~ '^pg_' ORDER BY n.nspname, c.relname
\gexec
SELECT 'invalid_index', schemaname, indexname
FROM pg_indexes i JOIN pg_class c ON c.relname = i.indexname
JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = i.schemaname
JOIN pg_index x ON x.indexrelid = c.oid
WHERE NOT x.indisvalid ORDER BY schemaname, indexname;
SQL
done

diff -ru /root/postgres-inventory-before /root/postgres-inventory-after-docker
(cd /opt/L4_DiscordBot && find data/production -type f -print0 | sort -z | xargs -0 -r sha256sum) \
  >/root/data-production-after.sha256
diff -u /root/data-production-before.sha256 /root/data-production-after.sha256

docker compose -p "$project" exec -T postgres psql -X -A -t -F '|' -v ON_ERROR_STOP=1 -U postgres -d l4discord \
  -c "SELECT storage_relpath, sha256_hex FROM message_attachment.message_log_attachment_files WHERE sha256_hex IS NOT NULL ORDER BY storage_relpath" |
  awk -F'|' 'NF == 2 { if ($1 !~ /^data\/[^\/].*/ || $1 ~ /(^|\/)\.\.?($|\/)/) exit 1; print $2 "  " $1 }' |
  (cd /opt/L4_DiscordBot && sha256sum -c -)
~~~

DBのスキーマ、所有者、権限、主要テーブル件数、シーケンス、無効インデックス、照合順序、
添付ファイルのハッシュが一致しない場合は、Botを起動せず延期します。
message_attachment以外のスキーマ名を設定している場合は、最後のSQLだけ実効スキーマ名へ置き換えます。

### Compose後のバックアップ確認

~~~bash
sudo install -d -m 0750 -o root -g postgres /etc/l4discord
sudoedit /etc/l4discord/postgresql-backup.env
sudoedit /var/lib/postgresql/.pgpass
sudo chown root:postgres /etc/l4discord/postgresql-backup.env
sudo chmod 0640 /etc/l4discord/postgresql-backup.env
sudo chown postgres:postgres /var/lib/postgresql/.pgpass
sudo chmod 0600 /var/lib/postgresql/.pgpass
sudo -u postgres test -r /etc/l4discord/postgresql-backup.env
sudo -u postgres test -r /var/lib/postgresql/.pgpass
sudo systemctl start l4-postgresql-backup.service
test "$(systemctl show -p Result --value l4-postgresql-backup.service)" = success
sudo systemctl enable --now l4-postgresql-backup.timer
~~~

この確認が成功するまで、Botの起動確認を合格扱いにしません。

### Bot起動と疎通確認

~~~bash
elapsed=$(( $(date +%s) - maintenance_started ))
(( elapsed < 1200 )) || { echo '04:20 cutoff reached; do not start applications' >&2; exit 1; }

if sudo systemctl is-active --quiet l4-discordbot; then
  echo 'systemd Bot is still active; aborting to prevent duplicate Discord login' >&2
  exit 1
fi
docker compose -p "$project" up -d bot
docker compose -p "$project" ps
docker compose -p "$project" logs --no-color --tail=200 bot
docker compose -p "$project" logs --no-color --tail=200 bot | grep -q 'Database runtime initialized successfully\.'

docker compose -p "$project" exec -T bot node --input-type=module -e \
  "import pg from 'pg'; const pool = new pg.Pool({connectionString: process.env.DATABASE_URL}); const r = await pool.query('SELECT current_user, current_database()'); console.log(JSON.stringify(r.rows[0])); await pool.end();"
docker compose -p "$project" exec -T bot test -r /app/data/production -a -w /app/data/production
docker compose -p "$project" exec -T bot test -r /app/data/message_log_attachments
docker compose -p "$project" exec -T bot node --input-type=module -e \
  "const r = await fetch('http://127.0.0.1:8787/health'); if (!r.ok) process.exit(1); console.log(await r.text());"
~~~

ログのDatabase runtime initialized successfully.、workerの{"ok":true}、BotのDiscord接続、
基本コマンド、添付ファイルの読み書きを確認します。Compose Botを起動する前にsystemd Botが停止しているため、
本番Discordトークンを使った二重起動にはなりません。

### 20分時点の切り戻し（Bot書き込み前）

DB検証が停止から20分以内に終わらない場合、またはBotをまだ起動していない場合だけ、次を実行します。
Composeのvolumeは残します。docker compose down -vは実行しません。

~~~bash
docker compose -p "$project" stop bot postgres
if [[ -f /etc/l4discord/postgresql-backup.env ]]; then
  mv /etc/l4discord/postgresql-backup.env /etc/l4discord/postgresql-backup.env.compose16-disabled
fi
if sudo systemctl is-active --quiet postgresql@14-main; then
  sudo systemctl stop postgresql@14-main
fi
sudo systemctl start postgresql@14-main
sudo -u postgres psql -X -d postgres -c 'SELECT version();'
sudo systemctl unmask l4-discordbot
sudo systemctl enable --now kendou-ranking l4-discordbot
sudo systemctl enable --now l4-postgresql-backup.timer
sudo systemctl status postgresql@14-main kendou-ranking l4-discordbot --no-pager
~~~

この段階ではPG16への書き込みがないため、旧systemd＋PG14へ戻せます。Compose volumeは調査用に保持します。

### 切替後の切り戻し

Compose BotがPG16へ書き込みを始めた後は、単にPG14を起動してはいけません。
PG16の書き込み後に戻す場合は、まずCompose Botを停止し、切り替え前バックアップをPG14へ論理復元します。
以下は、切替時に`/root/l4-pre-cutover-snapshot`へ保存したバックアップを使う例です。
DB復元でPG16の更新は失われます。`data/production`は共有ファイルなので自動削除せず、
復元前後のハッシュを比較し、必要なら別途取得済みのファイルバックアップから戻します。
この操作は別途明示承認を得てから行い、復元完了までBotを起動しません。

~~~bash
set -Eeuo pipefail
cd /opt/L4_DiscordBot
project=l4discord
sudo systemctl stop l4-postgresql-backup.timer
sudo systemctl stop l4-discordbot kendou-ranking
docker compose -p "$project" stop bot postgres
if [[ -f /etc/l4discord/postgresql-backup.env ]]; then
  mv /etc/l4discord/postgresql-backup.env /etc/l4discord/postgresql-backup.env.compose16-disabled
fi
if sudo systemctl is-active --quiet postgresql@14-main; then
  sudo systemctl stop postgresql@14-main
fi
sudo systemctl start postgresql@14-main
active_clients=$(sudo -u postgres psql -X -A -t -v ON_ERROR_STOP=1 -d postgres -c \
  "SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid();")
test "$active_clients" = 0

snapshot=$(cat /root/l4-pre-cutover-snapshot)
test -d "$snapshot"
sudo -u postgres sh -c "cd '$snapshot' && sha256sum --check SHA256SUMS"
for database in l4discord kendou_ranking; do
  sudo -u postgres dropdb --if-exists --force "$database"
done
pg_restore_bin=/usr/lib/postgresql/16/bin/pg_restore
test -x "$pg_restore_bin"
sudo -u postgres "$pg_restore_bin" --exit-on-error --create -U postgres -d postgres "$snapshot/l4discord.dump"
sudo -u postgres "$pg_restore_bin" --exit-on-error --create -U postgres -d postgres "$snapshot/kendou_ranking.dump"
(cd /opt/L4_DiscordBot && find data/production -type f -print0 | sort -z | xargs -0 -r sha256sum) \
  >/root/data-production-after-rollback.sha256
if ! diff -u /root/data-production-before.sha256 /root/data-production-after-rollback.sha256; then
  echo 'data/production changed after PG16 writes; keep files and restore from a separate file backup if required' >&2
fi
sudo systemctl unmask l4-discordbot
sudo systemctl enable --now kendou-ranking l4-discordbot
sudo systemctl enable --now l4-postgresql-backup.timer
sudo systemctl status postgresql@14-main kendou-ranking l4-discordbot --no-pager
~~~

切替前のロールはPG14クラスタに保持されているため、この例ではglobalsを同じクラスタへ再適用しません。
ロールが壊れている場合は、先に`globals.sql`を別の検証クラスタへ復元して確認し、手動で復旧手順を作成します。

## 切替後

~~~bash
docker compose -p l4discord ps
docker compose -p l4discord logs --no-color --tail=200 bot postgres
~~~

release向けデプロイはDocker方式へ切り替え済みです。Actionsはsystemdを再起動せず、
`/etc/l4discord/l4discord-compose.env`を使ってComposeのbotサービスだけを更新します。

旧14/mainは停止状態で7日間保持します。これは比較・調査用であり、PG16稼働後の復旧先ではありません。
7日後、最新PG16バックアップの完全復元に成功し、削除の明示承認を得た場合だけ旧クラスタを削除します。

docker compose down -vによるpostgres-data削除、Dockerイメージへの.env・data・DBデータの同梱、
Kubernetes・Portainer・別workerコンテナの追加、Node.jsからBunへの変更はこの移行の対象外です。

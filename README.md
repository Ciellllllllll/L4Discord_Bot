# L4 Discord Bot

Discordサーバーの管理や日常のやり取りを支援するBotです。TypeScriptとdiscord.jsで実装し、設定や利用履歴をPostgreSQLに保存します。

## 主な機能

| 分野 | 機能 |
| --- | --- |
| サーバー管理 | モデレーション、タイムアウトの投票、問い合わせチケット、Modmail、リアクションロール |
| 会話 | AIへの質問、利用モデルの切り替え、ユーザー別プロンプト |
| ボイスチャンネル | 一時チャンネルの管理、参加時間の記録とランキング |
| 通知・表示 | リマインダー、無料ゲームの通知、各種リンクのプレビュー |
| 遊び | 川柳の検出、人狼、スタンプランキング |

機能によって、APIキーや投稿先チャンネルの設定が必要です。設定項目は[.env.example](.env.example)、スラッシュコマンドの定義は[buildSlashCommands.ts](src/commands/buildSlashCommands.ts)で確認できます。

## 開発環境の準備

Node.jsとnpm、開発用のPostgreSQL、DiscordのBotアカウントを用意してください。Node.jsの指定は[.mise.toml](.mise.toml)で22系、[package.json](package.json)の最低要件は22.9.0です。リポジトリのDocker構成ではPostgreSQL 16を使っています。

以下のコマンドはリポジトリのルートで実行します。miseを導入済みなら、指定バージョンのNode.jsを準備して依存パッケージを入れられます。

```sh
mise install
mise exec -- npm ci
```

Node.jsを別の方法で管理している場合は、バージョンを確認したうえで`mise exec --`を省略できます。

### Discordとデータベース

開発用のBotを検証用サーバーへ招待してください。[クライアントの実装](src/bot/createClient.ts)はメンバー情報とメッセージ本文を受け取るため、Discord Developer PortalでServer Members IntentとMessage Content Intentを有効にします。Botにはメッセージ送信や埋め込み表示など、使う機能に必要な権限を与えてください。

PostgreSQLには開発専用のデータベースと接続ユーザーを用意します。Botは起動時にスキーマとテーブルを作成・更新するため、接続ユーザーにはその権限が必要です。スキーマは、データベース内でテーブルを用途ごとに分ける仕組みです。

### 環境変数

初回は`.env.example`を`.env`へコピーします。PowerShellでは次のコマンドを使えます。既に`.env`がある場合は、そのファイルを編集してください。

```powershell
Copy-Item .env.example .env
```

開発用の設定例です。`.env`内の該当項目を実際の値に置き換え、コメントになっている`DEBUG_DATABASE_URL`の行も有効にしてください。

```dotenv
BOT_PROFILE=debug
DEBUG_DISCORD_TOKEN=your_bot_token
DEBUG_DISCORD_CLIENT_ID=your_application_id
DEBUG_GUILD_ID=your_test_server_id
DEBUG_OWNER_ID=your_user_id
DEBUG_ADMIN_ROLE_ID=your_admin_role_id
DEBUG_DATABASE_URL=postgres://l4bot:your_password@127.0.0.1:5432/l4discord_debug
```

トークンには`Bot `や`Bearer `を付けず、発行された値だけを入れます。`.env`やトークン、データベースのパスワードはGitへ登録しないでください。

`BOT_PROFILE`は本番用の`production`と開発用の`debug`を切り替えます。`DEBUG_`または`PRODUCTION_`付きの設定は、同名の共通設定より優先されます。空欄でも共通設定を上書きするため、共通値を使う項目はプロファイル別の行を削除するかコメントにしてください。

プロファイルを変えてもデータベースは自動で分離されません。開発用には本番と別の接続先を指定してください。同じデータベースを使う場合は、`.env.example`にある8種類すべてのスキーマ名を環境ごとに分けます。

### 起動

```sh
mise exec -- npm run dev:utf8
```

このコマンドは`debug`プロファイルを使います。川柳のテストを実行した後、ソースの変更を監視してBotを再起動します。通常の開発起動には`npm run dev`も使えます。

Botは起動時にデータベースを更新し、Discordへの接続後に対象サーバーのスラッシュコマンドを同期します。`SKIP_COMMAND_SYNC=1`を指定すると同期を省略します。

接続ログの`discord gateway ready (clientReady)`を確認し、検証用サーバーで`/ping`の応答を確かめてください。`/ping`は開発用のコマンドです。機能の復元やコマンド同期に失敗していないか、接続後のログも確認します。

## ビルドと検証

| コマンド | 内容 |
| --- | --- |
| `mise exec -- npm run typecheck` | TypeScriptの型を検査 |
| `mise exec -- npm run lint` | コードの書き方を検査 |
| `mise exec -- npm run build` | `dist/`へ実行用JavaScriptを出力 |
| `mise exec -- npm test` | 一時的なPostgreSQLを使ってテストを実行 |

`npm test`にはDockerとDocker Composeが必要です。[テスト用構成](docker-compose.test.yml)でPostgreSQLを起動し、終了時にテスト用コンテナとボリュームを削除します。`npm run test:postgres`も同じ処理です。

ビルド済みのBotは次のコマンドで起動します。

```sh
mise exec -- npm start
```

`npm start`は`.env`を読み込み、`dist/index.js`を実行します。開発用コマンドと違い、`debug`への切り替えは行いません。起動前に`BOT_PROFILE`と接続先を確認してください。

## ディレクトリ構成

| パス | 内容 |
| --- | --- |
| `src/index.ts` | Botの起動処理 |
| `src/bot/` | Discord接続、イベント登録、データベース初期化 |
| `src/core/` | 環境変数、データベース接続、ログなどの共通処理 |
| `src/commands/` | スラッシュコマンドの定義と処理 |
| `src/interactions/` | ボタンや選択メニューなどの操作処理 |
| `src/message/` | メッセージの処理 |
| `src/features/` | 各機能の実装とテスト |
| `workers/` | 日本語解析などの補助サービス |
| `scripts/` | 開発起動、テスト、バックアップ用スクリプト |
| `deploy/` | 配備と定期バックアップの設定 |

## 運用資料

Docker Composeでの本番運用、バックアップ、復元手順は[PostgreSQL運用資料](docs/postgres-migration.md)にまとめています。メッセージの添付ファイルなどはデータベースとは別に保存するため、バックアップではファイルの保存先も確認してください。

日本語解析ワーカーを使う場合は、[導入手順](docs/japanese-worker-deployment.md)と[通信仕様](docs/japanese-worker-contract.md)を参照してください。

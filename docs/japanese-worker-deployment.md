# 日本語解析workerの起動と運用

日本語解析workerは、Botと同じホスト内で動くGo製のHTTPプロセスです。
Botから起動する方法と、あらかじめ別プロセスとして起動する方法があります。
通信形式は [API仕様](japanese-worker-contract.md) を参照してください。

## Docker Composeでの起動

リポジトリの [Dockerfile](../Dockerfile) はGo 1.26でworkerをビルドし、Node.js 22のBotイメージに同梱します。
[docker-compose.yml](../docker-compose.yml) はworkerの起動を既定で有効にし、Botコンテナ内の `http://127.0.0.1:8787` へ接続します。
worker専用のコンテナや公開ポートは不要です。

Composeは `PRODUCTION_JAPANESE_WORKER_ENABLED` も既定で `1` に設定します。
起動を無効にする場合は、Composeへ渡す環境変数でこの値を `0` にします。
Botの `.env` だけを変更しても、Composeの `environment` に指定された値が優先されます。

ユーザー辞書を使う場合は、Botの `.env` に `JAPANESE_WORKER_USER_DICT_PATH` を設定します。
例えば、ホスト側の `data/production/pacchi-userdic.csv` は、コンテナ内では `/app/data/production/pacchi-userdic.csv` と指定します。
辞書の読み込みに失敗するとworkerは起動しません。

Compose全体の設定は [PostgreSQLとBotの運用](postgres-migration.md) を参照してください。

## Botの解析設定

workerの起動と、各機能が使う解析方法は別々に設定します。
次の例は、workerを起動し、川柳検出とPacchi学習で利用する設定です。
川柳機能自体の有効化や、Pacchiのサーバー設定とチャンネルの学習設定も別途必要です。

```dotenv
JAPANESE_WORKER_ENABLED=1
JAPANESE_WORKER_URL=http://127.0.0.1:8787
JAPANESE_WORKER_TIMEOUT_MS=1500
SENRYU_DETECTOR_MODE=go-worker
SENRYU_WORKER_FALLBACK_ENABLED=1
SENRYU_WORKER_FALLBACK_ON_NO_MATCH=0
PACCHI_LEARNING_ANALYZER=go-worker
PACCHI_PATTERN_LEARNING_ENABLED=1
PACCHI_GENERATION_MODE=mixed
```

次の既定値は、Composeによる上書き前の [Bot設定](../src/core/config.ts) の値です。

| 設定 | 既定値 | 意味 |
| --- | --- | --- |
| `JAPANESE_WORKER_ENABLED` | `0` | Botによるworkerの起動管理と利用を有効にする |
| `JAPANESE_WORKER_URL` | `http://127.0.0.1:8787` | workerの接続先 |
| `JAPANESE_WORKER_TIMEOUT_MS` | `1500` | 通信の待ち時間。100〜30,000ミリ秒 |
| `SENRYU_DETECTOR_MODE` | `kuromoji` | 川柳の解析方法。workerを使う場合は `go-worker` |
| `SENRYU_WORKER_FALLBACK_ENABLED` | `1` | workerが無効、または通信に失敗した場合にkuromojiで解析する |
| `SENRYU_WORKER_FALLBACK_ON_NO_MATCH` | `0` | workerが候補なしを返した場合にkuromojiで再解析する |
| `PACCHI_LEARNING_ANALYZER` | `kuromoji` | workerによる語彙学習を使う場合は `go-worker` |
| `PACCHI_PATTERN_LEARNING_ENABLED` | `0` | workerの解析結果から文型も学習する |
| `PACCHI_GENERATION_MODE` | `template` | `template`、`slot-template`、`learned-pattern`、`mixed` から選択する |

`JAPANESE_WORKER_ENABLED` が未設定か空文字列の場合だけ、短い別名の `WORKER_ENABLED` を参照します。
表の設定には、`BOT_PROFILE` に応じた `PRODUCTION_` または `DEBUG_` 付きの値が優先されます。

川柳検出では、**フォールバック**（別の解析方法による代替処理）を、通信失敗時と候補なしの場合で個別に制御します。
workerが候補を返した場合は、kuromoji用のjs-haiku検証とAI審査を実行しません。
workerそのものが起動に失敗した場合はBotの起動エラーになり、川柳のフォールバック設定では回避できません。

## Botが管理するプロセス

Botは起動時に `/health` を確認します。
既に正常なworkerが応答する場合はそれを利用し、Botの終了時にも停止しません。

応答がない場合は、OSに対応した次のバイナリを探します。
存在しなければ `workers/japanese-worker` を作業ディレクトリとして `go run .` を実行します。

| OS | バイナリの場所 |
| --- | --- |
| Windows | `workers/japanese-worker/japanese-worker.exe` |
| Linuxなど | `workers/japanese-worker/japanese-worker` |

Botは `JAPANESE_WORKER_URL` のホスト名とポートから `JAPANESE_WORKER_ADDR` を組み立て、子プロセスへ渡します。
workerはループバック以外の待ち受け先を拒否し、HTTPで待ち受けます。
通常は既定のURLを使ってください。

起動後は最大120回、各確認の後に500ミリ秒待って稼働を確認します。
各要求にも待ち時間があるため、起動確認全体の上限は60秒固定ではありません。
Botが起動した子プロセスには、終了時に停止シグナルを送り、5秒で終了しなければ強制終了シグナルを送ります。
稼働中にworkerが終了した場合、Botはログへ記録しますが、workerだけを自動再起動する処理はありません。

## ローカルでのビルドと手動起動

ローカルでビルドする場合は、[go.mod](../workers/japanese-worker/go.mod) が指定するGo 1.26に対応するツールチェーンを用意します。
Windowsではリポジトリのルートから次を実行します。

```powershell
Set-Location workers/japanese-worker
go build -o japanese-worker.exe .
.\japanese-worker.exe
```

Linuxでは次を実行します。

```bash
cd workers/japanese-worker
go build -o japanese-worker .
./japanese-worker
```

開発時は、どちらのOSでも同じディレクトリで `go run .` を使えます。
別のターミナルから次を実行し、`{"ok":true}` が返ることを確認します。
Windows PowerShellでは `curl` の代わりに `curl.exe` を使えます。

```bash
curl --fail http://127.0.0.1:8787/health
```

手動起動時の待ち受け先は `JAPANESE_WORKER_ADDR`、任意のユーザー辞書は `JAPANESE_WORKER_USER_DICT_PATH` で指定します。
これらはworkerが直接読む環境変数なので、`PRODUCTION_` や `DEBUG_` を付けません。

## systemdでworkerを常駐させる場合

Docker Composeを使わず、ホスト上のBotから外部workerへ接続する構成では、次のようなサービスを用意できます。
配置先と実行ユーザーは環境に合わせて変更してください。
Botにworkerの起動を任せる場合、このサービスは不要です。

```ini
[Unit]
Description=L4 Japanese Worker
After=network.target

[Service]
Type=simple
User=l4bot
WorkingDirectory=/opt/L4_DiscordBot/workers/japanese-worker
Environment=JAPANESE_WORKER_ADDR=127.0.0.1:8787
# 任意のユーザー辞書を使う場合だけ指定します。
# Environment=JAPANESE_WORKER_USER_DICT_PATH=/opt/L4_DiscordBot/data/production/pacchi-userdic.csv
ExecStart=/opt/L4_DiscordBot/workers/japanese-worker/japanese-worker
Restart=always
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

## ローカルでの検証

Bot側の設定と通信処理は、リポジトリのルートで確認できます。

```powershell
mise exec -- npx tsx src/features/japaneseAnalysis/japaneseAnalysisClient.spec.ts
mise exec -- npx tsx src/features/japaneseAnalysis/japaneseWorkerProcess.spec.ts
```

workerの処理は、Goのテストで確認できます。

```bash
cd workers/japanese-worker
go test ./...
```

これらのテストだけでは、本番コンテナでの起動やDiscord上の返信までは確認できません。
反映先では稼働確認に加え、対象チャンネルで川柳検出とPacchi学習を確認してください。

# Japanese Worker Deployment

Japanese worker は Discord Bot から管理できるローカル専用プロセスです。

`JAPANESE_WORKER_ENABLED=1` または `WORKER_ENABLED=1` の場合、Bot は起動時に `/health` を確認し、worker が未起動なら `workers/japanese-worker` を子プロセスとして起動します。Bot が起動した worker は Bot の shutdown 時に停止します。

既に `/health` が成功する worker が外部起動済みの場合、Bot は二重起動しません。その場合、その外部 worker は Bot shutdown 時にも停止しません。

## Environment

```txt
JAPANESE_WORKER_ENABLED=1
# WORKER_ENABLED=1 も短い別名として使用できます。
JAPANESE_WORKER_URL=http://127.0.0.1:8787
JAPANESE_WORKER_TIMEOUT_MS=1500
SENRYU_DETECTOR_MODE=go-worker
SENRYU_WORKER_FALLBACK_ENABLED=1
PACCHI_LEARNING_ANALYZER=go-worker
PACCHI_PATTERN_LEARNING_ENABLED=1
PACCHI_GENERATION_MODE=mixed
```

worker は loopback のみに bind します。既定の待ち受けは `127.0.0.1:8787` です。Bot 管理起動時は `JAPANESE_WORKER_URL` から `JAPANESE_WORKER_ADDR` を組み立てて worker に渡します。

## Bot 管理起動

Bot は次の順で worker の起動コマンドを選びます。

```txt
workers/japanese-worker/japanese-worker.exe  # Windowsで存在する場合
workers/japanese-worker/japanese-worker      # Linux等で存在する場合
go run .                                     # バイナリが無い場合
```

ローカル debug では Go が PATH にあれば追加操作なしで `go run .` により起動できます。本番ではあらかじめ worker バイナリを配置しておく運用を推奨します。

## 任意の手動起動

Bot に管理させず、worker を別プロセスとして起動しておくこともできます。

```txt
cd workers/japanese-worker
go run .
```

疎通確認:

```txt
curl http://127.0.0.1:8787/health
```

## systemd 例

Bot 管理起動を使う場合、worker 用 service は不要です。

```ini
[Unit]
Description=Pacchi Discord Bot
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/l4discord-bot
EnvironmentFile=/opt/l4discord-bot/.env
ExecStart=/usr/bin/node bot.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

worker を外部プロセスとして常駐させたい場合だけ、別 service を用意します。

```ini
[Unit]
Description=Pacchi Japanese Worker
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/l4discord-bot/workers/japanese-worker
Environment=JAPANESE_WORKER_ADDR=127.0.0.1:8787
# Kagome user dictionary file を使う場合だけ指定します。
# Environment=JAPANESE_WORKER_USER_DICT_PATH=/opt/l4discord-bot/data/pacchi-userdic.csv
ExecStart=/opt/l4discord-bot/workers/japanese-worker/japanese-worker
Restart=always
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

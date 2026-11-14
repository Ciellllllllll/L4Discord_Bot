# ぱっちぃで自作AIを試す

`PACCHI_GENERATION_MODE=tiny-ai` にすると、通常の「ぱっちぃ」への呼びかけに、保存済みモデルが生成した文章を使います。既定値は引き続き `template` です。

このモデルは文字列の続きを生成する小型Transformerです。質問に正確に答えるための会話学習はしていません。「ぱっちぃ 明日は」と送ると「明日は」に続く文章を生成し、入力部分を含めて返します。「ぱっちぃ」だけなら空の入力から生成します。入力は最大48文字、追加生成は最大64文字です。会話履歴は入力に含めません。

じゃんけん、睡眠、用語説明、575などの専用処理、サーバー・チャンネルの有効設定、クールダウン、既存の語彙学習は維持します。通常のメッセージ全部に返答する変更ではありません。Discordへの新しい書き込みでモデルの重みが自動更新されることもありません。

## 構成

Bot → Docker内部の `tiny-ai:8790` → CPU上の学習済みモデル、という構成です。推論APIはFastAPIで実装し、起動時にモデルを一度だけ読み込みます。生成そのものに外部AIサービスやベクトルデータベースは使いません。ただし、既存の `PACCHI_AI_FINAL_CHECK_ENABLED` を有効にしている場合は、従来どおり生成後の判定で外部AIを使います。

推論サービスはCPU 0.75コア・メモリ512MiBに制限し、同時生成は1件までです。待ち時間は既定5秒。停止、混雑、タイムアウト、空の文章、入力をそのまま返しただけの文章、既存フィルターに合わない文章はテンプレート返信に戻します。フィルターは文章の正確さや自然さを保証するものではありません。

APIのポートはホストに公開しません。アクセス認証を持たない内部APIなので、`ports` を追加して公開しないでください。入力・出力の本文はAPIのアクセスログやBotの失敗ログに記録しません。Discordメッセージ自体の既存保存処理は変わりません。

## VPSで有効にする手順

このPRの作成時点では本番へ配備していません。以下は、この変更を含むBotイメージとリポジトリが通常のリリース手順で配備された後に実施する操作です。

1. `ssh conoha-root` で入り、`/opt/L4_DiscordBot` に移動します。モデルの既定パスは `/opt/l4-tiny-ai/runs/quality-v2/medium/best.pt` です。学習データとモデルファイルはGitやイメージに含めません。別の場所を使う場合はCompose用の `/etc/l4discord/l4discord-compose.env` に `PACCHI_TINY_AI_MODEL_PATH` を指定します。
2. 以下の関数で、通常配備と同じComposeプロジェクト・環境ファイルを指定します。`BOT_ENV_FILE` が指すBot設定ファイルと、Composeの変数用ファイルは別物です。

   ```bash
   cd /opt/L4_DiscordBot
   compose() {
     docker compose -p l4discord \
       --env-file /etc/l4discord/l4discord-compose.env \
       --env-file /opt/L4_DiscordBot/.deploy-bot-image.env "$@"
   }
   compose --profile tiny-ai config --quiet
   compose --profile tiny-ai up -d --build --wait tiny-ai
   ```

3. `BOT_ENV_FILE` が指す既存のBot設定ファイルで、次を設定します。事前に元の値を控えてください。

   ```dotenv
   PRODUCTION_PACCHI_GENERATION_MODE=tiny-ai
   PRODUCTION_PACCHI_TINY_AI_URL=http://tiny-ai:8790
   PRODUCTION_PACCHI_TINY_AI_TIMEOUT_MS=5000
   ```

4. Botに設定を読み直させます。データベースを再作成する必要はありません。

   ```bash
   compose up -d --no-deps --force-recreate bot
   compose --profile tiny-ai ps
   ```

5. 管理者が試すチャンネルで `!pacchi_status` を確認します。無効なら必要に応じて `!pacchi_on server` と `!pacchi_on channel` を実行し、「ぱっちぃ 明日は」または「ぱっちぃ」と送ります。連続送信時は既存のクールダウンを待ってください。

このモードはBot全体の設定です。試験対象を限定したい場合は既存のチャンネル設定を使います。AIに失敗しても返信自体は続くので、疎通不良はBotログの `pacchi tiny AI` 警告とサービスのhealth状態で確認してください。

通常の配備処理はBotだけを更新します。推論側のコードを変更したときは、手順2で推論イメージを再ビルドしてください。

## 元に戻す

Bot設定の `PRODUCTION_PACCHI_GENERATION_MODE` を元の値（通常 `template`）へ戻し、`compose up -d --no-deps --force-recreate bot` を実行します。推論サービスも止めるなら `compose --profile tiny-ai stop tiny-ai` を実行します。モデル・学習データ・PostgreSQLデータは削除しません。

## 検証

Bot側は既存の `npm test` にAPI成功・失敗・タイムアウト・混雑・危険な出力・チャンネル設定・クールダウンの検証を含めています。推論APIは `python -m unittest discover -s experiments/tiny-ai -p test_server.py` で検証します（先に `requirements-test-serve.txt` をインストール）。

CIでは推論イメージもビルドし、外部ネットワークなしのコンテナでモデルのテストと `smoke_service.py` を実行します。後者は架空の重みを生成し、本番と同じHTTPサーバーでモデル読み込みと生成を確認します。実際のDiscord送受信、VPS上の学習済みモデルとの一連の接続、文章品質の評価とは別の検証です。

# 小型推論サービスによるテキスト生成

環境変数`PACCHI_GENERATION_MODE=tiny-ai`を設定すると、自動応答機能の通常返信に、学習済みの小型言語モデルが生成した文章を使います。既定値は`template`のままです。

このモデルは文字列の続きを予測する小型Transformerであり、質問へ正確に答えるための会話学習は行っていません。呼びかけのあとに続けた語句を入力として続きを生成し、入力部分を含めて返します。呼びかけだけの場合は空の入力から生成します。入力は最大48文字、追加生成は最大64文字で、会話履歴は入力に含めません。

専用の定型処理、サーバー・チャンネルの有効設定、クールダウン、既存の語彙学習は従来どおり維持されます。すべてのメッセージへ返答する仕組みではなく、呼びかけを含むメッセージへの返信だけに推論サービスを使います。呼びかけ直後の「、」「！」などの記号は入力から取り除きます。Discordへの新しい投稿によってモデルの重みが自動更新されることはありません。

## 構成

BotからDocker内部ネットワークの`tiny-ai:8790`へHTTP要求を送り、CPU上の学習済みモデルで文章を生成します。推論APIはFastAPIで実装しており、起動時にモデルを一度だけ読み込みます。文章の生成自体に外部AIサービスやベクトルデータベースは使いません。ただし、既存の`PACCHI_AI_FINAL_CHECK_ENABLED`を有効にしている場合は、従来どおり生成後の判定で外部AIを使います。

[docker-compose.yml](../docker-compose.yml)では、推論サービスの資源上限をCPU 0.75コア・メモリ512MiBに制限し、同時生成を1件までに抑えています。待ち時間の既定値は5秒です。停止中、混雑、タイムアウト、空の応答、入力をそのまま返しただけの応答、既存フィルターに合わない応答が発生した場合は、テンプレート返信へ戻ります。フィルターは文章の正確さや自然さを保証するものではありません。

推論APIのポートはホストへ公開しません。認証を持たない内部APIのため、`ports`を追加して外部へ公開しないでください。入出力の本文はAPIのアクセスログやBotの失敗ログに記録しません。Discordメッセージ自体の既存保存処理には影響しません。

## 有効にする手順

モデルファイルと学習データはリポジトリやコンテナイメージに含めません。あらかじめ[experiments/tiny-ai](../experiments/tiny-ai/README.md)の手順でモデルファイル（`best.pt`）を用意し、以下の手順で有効にします。

1. Composeへ渡す環境変数で`PACCHI_TINY_AI_MODEL_PATH`に学習済みモデルファイルのホスト側パスを指定し、`tiny-ai`プロファイルを起動します。

   ```bash
   docker compose --profile tiny-ai config --quiet
   docker compose --profile tiny-ai up -d --build --wait tiny-ai
   ```

2. Botの環境変数ファイル（`.env`など）に次を設定します。元に戻せるよう、変更前の値を控えておいてください。

   ```dotenv
   PRODUCTION_PACCHI_GENERATION_MODE=tiny-ai
   PRODUCTION_PACCHI_TINY_AI_URL=http://tiny-ai:8790
   PRODUCTION_PACCHI_TINY_AI_TIMEOUT_MS=5000
   ```

3. Botコンテナを再作成して設定を読み直させます。データベースの再作成は不要です。

   ```bash
   docker compose up -d --no-deps --force-recreate bot
   docker compose --profile tiny-ai ps
   ```

4. 自動応答機能が有効なチャンネルでメッセージを送り、応答を確認します。連続送信時は既存のクールダウンを待ってください。

このモードはBot全体の設定です。試験対象を限定したい場合は、既存のチャンネルごとの有効設定を使います。推論に失敗してもテンプレート返信は続くため、疎通不良はBotログの`pacchi tiny AI`警告とサービスのhealth状態で確認してください。推論側のコードを変更したときは、手順1で推論イメージを再ビルドします。

## 元に戻す

Botの環境変数`PRODUCTION_PACCHI_GENERATION_MODE`を元の値（通常は`template`）へ戻し、Botコンテナを再作成します。

```bash
docker compose up -d --no-deps --force-recreate bot
```

推論サービスも停止する場合は次を実行します。モデルファイル、学習データ、PostgreSQLのデータは削除されません。

```bash
docker compose --profile tiny-ai stop tiny-ai
```

## 検証

Bot側は通常の`npm test`に、API成功、失敗、タイムアウト、混雑、不適切な出力、チャンネル設定、クールダウンの検証を含めています。推論API側は`requirements-test-serve.txt`をインストールしたうえで、次を実行して検証できます。

```sh
python -m unittest discover -s experiments/tiny-ai -p test_server.py
```

CIでは推論イメージをビルドし、外部ネットワークを遮断したコンテナ内でモデルのテストと`smoke_service.py`を実行します。`smoke_service.py`は架空の重みを用いて本番と同じHTTPサーバーの読み込みと生成を確かめるもので、実際のDiscord送受信や文章品質の評価とは別です。

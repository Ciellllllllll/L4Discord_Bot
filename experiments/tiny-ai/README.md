# Discordメッセージで小さな言語モデルを学習する実験

品質改善版の実験方法と選定モデルの使い方は[QUALITY.md](QUALITY.md)を参照してください。

既存Botとは別のコンテナで、文字の続きを予測する小型Transformerをゼロから学習します。microgptやmakemoreの教育的な構成を参考にした独自のPyTorch実装です。既存モデルの重み、外部の推論API、ベクトルデータベースは使いません。短文の生成が目的であり、質問への正確な回答や返信関係の学習は対象外です。

## データ

`prepare.py`はPostgreSQLの`message_log.message_logs`を読み取り専用で参照します。全サーバー、全チャンネル、全投稿者を対象とし、画像や添付ファイルの中身は扱いません。削除記録のあるメッセージを除き、編集を最新の本文にまとめます。URL、メンション、Discord ID、カスタム絵文字を置き換え、空本文と同一本文の重複を除きます。これらの置換は完全な匿名化を保証するものではありません。

本文のSHA-256で約90%を学習用、約10%を評価用に振り分けます。同一の整形済み本文が両方に入ることはありませんが、類似文は残り得ます。語彙は学習用データだけから作り、評価用だけに出る文字は未知文字として扱います。64文字を超える本文も切り捨てず、複数の区間に分けて学習に使います。別々の発言を隣り合わせの会話と見なす処理は行いません。

## 実行手順

作業ディレクトリ（`experiments/tiny-ai`など）へ移動して実行します。抽出したデータと学習済みモデルはローカル環境だけに保存し、所有者だけがアクセスできる権限で管理してください。データとモデルはGitへ含めません。

```sh
# 初回のみ。既存のdataディレクトリへの上書きは拒否します。
python3 prepare.py --out ./data
docker build -t l4-tiny-ai:experiment .

# まず1周だけ試運転します。各train実行では新しい出力先を指定してください。
./ai train --data /data --out /runs/smoke --epochs 1
./ai train --data /data --out /runs/first --epochs 8

# 保存したモデルを別プロセスで読み込み、続きを生成します。
./ai generate --model /runs/first/best.pt --prompt 'こんにちは' --count 5
```

`ai`はCPUを0.75コア分、メモリを512MiBに制限し、追加のswapを許可しません。学習・生成中はネットワークなしで実行し、ポートは公開しません。既存Botの設定、イメージ、データベースのデータは変更せず、自動起動やDiscordへの送信も行いません。停止するには実行中のコマンドを中断するか、その実験コンテナだけを`docker stop`で停止します。

`best.pt`は評価用データの予測誤差が最も小さかったモデル、`last.pt`は最終モデルです。最初から再学習するコマンドであり、学習の中断再開には未対応です。`report.json`にパラメータ数、評価結果、実行時間、プロセスの最大メモリ量を記録します。モデルファイルを読み込むのは自分で生成したものに限定してください。

## 検証

```sh
python3 -m unittest test_prepare
# 合成データを使ってPostgreSQLからの抽出と編集・削除の取り扱いを検証します。
python3 -m unittest test_export
docker run --rm --network none --cpus 0.75 --memory 512m --memory-swap 512m \
  --entrypoint python l4-tiny-ai:experiment -m unittest test_model
```

これらのテストでは前処理、学習用と評価用の重複防止、未来の文字を参照しないこと、長文の切り分けで学習対象の文字を失わないこと、小さな教材で学習が進むこと、保存・再読込後の出力一致を確認します。

PyTorchがNumPy未導入の警告を表示する場合がありますが、この実装はNumPyを使わず、テンソル演算、学習、生成をPyTorchのみで実行します。

参考: https://karpathy.github.io/2026/02/12/microgpt/ 、https://github.com/karpathy/makemore

---
name: discordbot-security-implementation
version: 1.0.0
description: Discord BOT の新規実装・改修・レビュー時に使用するセキュリティ担保用スキル。discord.py / discord.js / TypeScript / Python / SQLite / PostgreSQL / Bot-Hosting系環境を前提に、トークン管理、権限制御、入力検証、外部連携、監査ログ、AI連携、運用保守までを一貫して安全に実装させる。目的は「動くBOT」ではなく「本番運用に耐えるBOT」を作ること。セキュリティ・拡張性・保守性を最優先し、危険実装を禁止し、実装規約・レビュー基準・コミット可否基準を明文化する。
---

# Discord BOT セキュリティ実装スキル

## 目的

このスキルは、Discord BOT の機能追加、改修、レビュー、リファクタリング時に、セキュリティ・拡張性・保守性を最高優先で担保するための実装基準である。

対象は以下を含む。

- Discord BOT 本体
- slash command / prefix command / UI components / modal / button / select menu
- 自動モデレーション機能
- ログ収集・監査機能
- SQLite / PostgreSQL / Redis 等のデータ層
- 外部API連携
- Webhook / OAuth2 / Dashboard / 管理API
- LLM連携やAI補助機能
- Bot-Hosting系やVPS等の運用環境

このスキルの最終目標は次の3点である。

1. 機密情報を漏らさない
2. 権限逸脱や悪用を許さない
3. 今後の機能追加で壊れにくい設計にする

安全性に疑義がある場合は、利便性より安全側に倒す。

---

## 最上位原則

### 1. 秘密情報はコードに置かない

Discord Bot Token、DB接続情報、APIキー、Webhook URL、OAuth client secret、JWT secret、LLM API key は、コード、サンプルコード、コメント、ログ、テストデータ、スクリーンショットに含めない。

### 2. 権限は最小化する

Discord権限、BOT権限、ロール権限、DB権限、外部API権限、ファイル権限はすべて最小権限で構成する。

### 3. ユーザー入力は常に不正と仮定する

メッセージ本文、添付、カスタムID、モーダル入力、スラッシュコマンド引数、URL、Embed内容、LLM出力を信頼しない。

### 4. 危険操作は明示確認を必須化する

削除、BAN、TIMEOUT、ロール付与、メッセージ一括処理、外部送信、課金相当操作、永続データ更新は、確認ステップまたは権限再確認を必須にする。

### 5. 監査可能であること

誰が、いつ、どのサーバーで、何を実行し、何が変更されたかを追跡できる構造にする。

### 6. 機能追加より設計整合を優先する

新機能は既存の権限チェック、エラーハンドリング、ログ設計、DB抽象化、設定管理を流用し、例外的な書き方を増やさない。

---

## 実装前に必ず確認すること

実装やレビュー開始前に以下を把握する。

- 使用言語とランタイム
  - discord.js / TypeScript
  - discord.py / Python
- データ保存先
  - SQLite / PostgreSQL / Redis / JSON
- ホスティング環境
  - Bot-Hosting / VPS / Docker / Serverless
- 対象機能
  - moderation / logging / economy / AI / dashboard / auth / sync
- 取り扱うデータ
  - メッセージログ / ユーザーID / メール / OAuth情報 / 罰則履歴 / 添付URL
- 外部連携
  - OpenAI / Anthropic / Google / Slack / Webhook / 独自API

情報不足があっても実装を甘くしない。不明点がある場合は安全な前提で設計する。

---

## Top 15 クリティカルチェック

以下は最優先で確認する。1件でも該当したら即修正対象とする。

1. Bot Token や API key のハードコード
2. `.env` や secret を Git 追跡している
3. 管理コマンドに管理者チェックがない
4. `interaction.user.id` や `memberPermissions` の検証が漏れている
5. DBクエリへ文字列連結でユーザー入力を渡している
6. 任意のロールIDやユーザーIDを検証せず変更操作に使っている
7. 任意URLをそのまま fetch / requests / aiohttp している
8. Webhook URL を平文保存または平文出力している
9. ログにトークン、Cookie、Authorization header、PII を出力している
10. エラー詳細や stack trace をそのまま Discord 上へ返している
11. `eval` `exec` `Function` `subprocess shell=True` 等で入力やLLM出力を実行している
12. 添付ファイルやファイル名を無検証で保存している
13. レート制限やクールダウン無しで重いコマンドを公開している
14. AI機能でユーザー入力を system prompt に直結している
15. 危険操作に確認UIや監査ログがない

---

## 実装の基本方針

### セキュリティ

- すべて deny by default を基本とする
- 権限チェックは handler の先頭で行う
- 1つの機能に複数の防御層を持たせる
- 例外時は安全に失敗させる
- 内部情報は外に出さない

### 拡張性

- 機能ごとに Cog / Module / Service / Repository / Policy を分離する
- Discordイベント処理とビジネスロジックを分離する
- IDや定数は一箇所に集約する
- 設定値は環境変数または設定テーブルに集約する
- 監査ログ形式を全機能で統一する

### 保守性

- 権限チェック関数を共通化する
- DBアクセスは repository 層に閉じ込める
- 監査ログ、バリデーション、エラー整形は共通化する
- コメントは意図を書く。変更履歴はコメントに書かない
- 臨時回避コードを残さない

---

## 推奨アーキテクチャ

以下のような責務分離を強く推奨する。

```text
bot/
  core/
    config
    constants
    logger
    errors
    security
    permissions
    rate_limit
  cogs_or_modules/
    moderation
    logging
    economy
    ai
    admin
  services/
    user_service
    guild_service
    punishment_service
    message_log_service
    ai_service
  repositories/
    user_repository
    config_repository
    audit_repository
  policies/
    role_policy
    channel_policy
    content_policy
  utils/
    validators
    discord_helpers
    time_helpers
    id_helpers
```

必須ルール。

- イベントハンドラ内で生SQLを直接書かない
- イベントハンドラ内で外部API呼び出しを直接多段実行しない
- 権限ロジックを各コマンドへコピペしない
- `if admin_id == ...` のような単発例外分岐を乱立させない

---

## カテゴリA: シークレット管理と設定安全性

### A-1 トークン管理

確認項目。

- `DISCORD_TOKEN` をコードに直接書いていないか
- `.env` を Git 管理していないか
- 起動失敗時に token の一部をログ出力していないか
- テストコードや README に本物のキーが残っていないか

必須要件。

- トークンは環境変数または秘密管理基盤から取得する
- ログには token を一切出さない
- token は漏洩前提でローテーション可能な構造にする

例。

```ts
// NG
const client = new Client({ intents: [] });
client.login("YOUR_DISCORD_BOT_TOKEN");

// OK
const token = process.env.DISCORD_TOKEN;
if (!token) {
  throw new Error("DISCORD_TOKEN is required");
}
await client.login(token);
```

```py
# NG
bot.run("Mz....")

# OK
import os

token = os.getenv("DISCORD_TOKEN")
if not token:
    raise RuntimeError("DISCORD_TOKEN is required")
bot.run(token)
```

### A-2 設定の一元管理

- 環境変数読み取りはアプリ全体で1箇所に集約する
- 値の型変換と妥当性検証を行う
- チャンネルID、ロールID、ギルドIDは文字列のまま散在させない
- 不正な設定値で起動継続しない

### A-3 秘匿情報の露出防止

- Webhook URL、OAuth secret、JWT secret、LLM API key を embed、console、trace、DB へ保存しない
- 管理者向け診断コマンドでも秘匿値を表示しない
- config dump 機能を作る場合は機密値を自動マスクする

---

## カテゴリB: 認証・認可・権限制御

### B-1 Discord権限チェック

確認項目。

- 管理系コマンドに `Administrator` または明示ロールチェックがあるか
- BOT側に必要権限が不足した時、安全に中断するか
- DMとGuildで前提が異なる機能に分岐があるか

必須要件。

- 権限チェックは実処理前に行う
- 「呼び出せたら実行できる」状態を作らない
- ギルド限定コマンドは DM で実行不可にする

```ts
function assertAdmin(interaction: ChatInputCommandInteraction) {
  if (!interaction.inGuild()) throw new Error("Guild only");
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    throw new Error("Forbidden");
  }
}
```

### B-2 ロール階層と対象操作の安全性

- タイムアウト、BAN、KICK、ロール付与時は対象メンバーの role hierarchy を検証する
- BOTより上位ロールの対象を処理しない
- 実行者より上位ロールの対象を処理しない
- 管理者ロールに対する変更操作は別扱いで厳格にする

### B-3 IDOR相当の防止

Discord BOT では、他人の設定や申請やチケットを custom_id や message_id 経由で操作されるリスクがある。

必須要件。

- `custom_id` 内の対象IDだけで信用しない
- interaction 実行者が対象の所有者か管理者かを都度検証する
- message component は押した人を制限する

```ts
// 例: チケットクローズボタン
if (ticket.ownerId !== interaction.user.id && !isStaff(interaction.member)) {
  return interaction.reply({ content: "この操作はできません", ephemeral: true });
}
```

### B-4 OAuth / Dashboard 連携

- OAuth state を必ず検証する
- redirect_uri を固定し、動的に受け取らない
- アクセストークンをログ出力しない
- Guild管理操作は OAuth ログイン済みでも別途 guild membership と権限を確認する

---

## カテゴリC: 入力検証とインタラクション安全性

### C-1 Slash command / Modal / Button 入力検証

確認項目。

- 文字数上限があるか
- 数値範囲があるか
- ID形式を検証しているか
- 空文字、改行、制御文字、過剰メンションを制御しているか

必須要件。

- バリデーションは Discord UI 上の制限に依存しない
- DB保存前に再検証する
- URL、数値、日付、列挙値は型別に検証する

### C-2 mention abuse と mass ping 対策

- BOTがユーザー入力をそのまま送信しない
- `@everyone` `@here` ロールメンションを抑制する
- `allowedMentions` を明示指定する

```ts
await interaction.reply({
  content: safeContent,
  allowedMentions: { parse: [] }
});
```

### C-3 Embed 安全性

- Embed にユーザー入力を入れる場合も長さ制限と整形を行う
- URLは http/https のみ許可する
- `javascript:` `data:` `file:` を拒否する
- 外部画像URLやリンクは allowlist ベースで制限可能にする

### C-4 custom_id 設計

- custom_id に秘密情報を入れない
- 署名や nonce を持たない脆弱な状態識別を避ける
- 長期有効な操作ボタンを放置しない
- 期限切れ時は無効応答を返す

推奨。

- `feature:action:resourceId:nonce` 形式
- DB上の state と照合する
- 危険操作は一度きりで無効化する

---

## カテゴリD: データ層と永続化安全性

### D-1 SQLインジェクション対策

必須要件。

- 生SQLへ文字列連結しない
- プレースホルダを使う
- ORDER BY や LIMIT 等も allowlist で制御する

```py
# NG
query = f"SELECT * FROM users WHERE user_id = '{user_id}'"
await db.execute(query)

# OK
await db.execute("SELECT * FROM users WHERE user_id = ?", (user_id,))
```

```ts
// NG
await db.prepare(`SELECT * FROM logs WHERE channel_id = '${channelId}'`).all();

// OK
await db.prepare("SELECT * FROM logs WHERE channel_id = ?").all(channelId);
```

### D-2 Repository層の強制

- DBアクセスは repository へ閉じ込める
- transaction 境界を service 層で管理する
- schema migration を手動差分で散在させない
- SQLite の場合も migration を正式に管理する

### D-3 JSON保存の乱用禁止

- 権限制御や検索条件などの重要構造を巨大JSON文字列で雑に保存しない
- クエリ可能なものは列として正規化する
- 添付や embed の生 payload を丸ごと無制限保存しない

### D-4 監査ログの保存

以下を監査ログへ残す。

- actor_user_id
- target_user_id
- guild_id
- channel_id
- action
- reason
- old_value / new_value の要約
- created_at
- correlation_id

ただし token、secret、本文の過剰全文保存、秘匿ヘッダは残さない。

---

## カテゴリE: Discord固有の危険操作

### E-1 モデレーション機能

BAN、KICK、TIMEOUT、ROLE操作、DELETE操作は高危険度とする。

必須要件。

- 実行者権限チェック
- BOT権限チェック
- role hierarchy チェック
- reason 必須化
- 監査ログ記録
- 可能なら確認UI
- 連打防止

### E-2 一括操作

- purge、bulk delete、mass role、mass DM は上限を設ける
- 件数上限なしで実行しない
- dry-run または件数確認を用意する
- 実行結果を監査ログへ記録する

### E-3 自動実行系イベント

- `on_message` `messageCreate` `memberJoin` 等で重い処理を直列実行しない
- 同一イベントの多重処理を防ぐ
- 再送や再起動で二重反映しないよう冪等性を持たせる

### E-4 Webhook と転送機能

- 任意のWebhook URLへ投稿可能にしない
- 送信先を設定テーブルと allowlist で制御する
- Slackや他サービスからの転送時は署名検証や送信元検証を行う
- 転送本文中のメンションや危険リンクを再検査する

---

## カテゴリF: 添付ファイル・URL・外部通信

### F-1 URL検証

確認項目。

- 任意URLを直接取得していないか
- ローカルアドレスやメタデータIPへ到達しないか
- リダイレクト追跡で内部へ飛ばないか

必須要件。

- URLは `http` `https` のみ許可
- ドメイン allowlist を使える設計にする
- IP直指定、localhost、private IP、metadata IP を拒否する
- timeout と size limit を設定する

### F-2 添付処理

- MIME type と拡張子の両方を確認する
- サイズ上限を設ける
- ファイル名は保存前に正規化する
- 実行可能ファイルやHTMLを無条件保存しない
- 一時ファイルは処理後に削除する

### F-3 外部API

- timeout、retry、backoff を設定する
- 失敗時に秘密情報を含むレスポンスを表示しない
- ステータスコードと失敗理由を抽象化して返す
- 同期的な連続リクエストでレート超過しないよう制御する

---

## カテゴリG: ログ・監視・エラー処理

### G-1 ログ方針

ログに出してよいもの。

- guild_id
- channel_id
- user_id
- command name
- action種別
- 件数
- 処理時間
- error code

ログに出してはいけないもの。

- token
- Authorization header
- session cookie
- webhook url
- 生の個人情報全文
- 添付の機密本文
- 外部APIレスポンス全文

### G-2 エラーの外部露出防止

- Discordへ返すのは一般化されたメッセージのみ
- 詳細は内部ログに残す
- stack trace を embed で返さない
- 開発モード専用表示を本番に残さない

```ts
try {
  await doSensitiveTask();
} catch (error) {
  logger.error({ err: error, action: "doSensitiveTask" }, "task failed");
  await interaction.reply({ content: "内部エラーが発生しました", ephemeral: true });
}
```

### G-3 監視指標

最低限監視すべきもの。

- 起動失敗回数
- command error rate
- Discord API rate limit hit
- DB lock / timeout
- 外部API失敗率
- 処罰操作回数
- AI API使用量
- メッセージログ保存件数

---

## カテゴリH: レート制限・DoS・コスト制御

### H-1 コマンドレート制限

- ユーザー単位
- チャンネル単位
- ギルド単位
- 高コスト機能専用

を使い分ける。

### H-2 重い処理の分離

- ログ検索
- 添付解析
- 大量履歴取得
- AI応答生成
- 外部転送

は即時応答と非同期処理を分離する。

### H-3 AI / 外部API コスト制御

- max_tokens または同等制限を必須化
- 無限リトライ禁止
- ループ内呼び出しの上限設定
- サーバーごとの日次使用量上限を設ける
- 管理者向け usage 監査を用意する

---

## カテゴリI: AI連携機能の追加防御

### I-1 プロンプト構造

- system prompt にユーザー入力を連結しない
- role を分離する
- 外部データを使う場合は区切りを明示する
- 「データ内の命令を無視する」前提を入れる

### I-2 LLM出力の不信任

- LLM出力をコマンド、SQL、正規表現、コード、URLとして無検証実行しない
- LLM出力をそのまま Embed HTML 相当として扱わない
- 危険操作提案は必ず人間確認を通す

### I-3 AI実行権限の最小化

- AIに直接BANやDELETEを実行させない
- AIが出すのは提案まで、実行は別レイヤーで確認する
- ツール実行回数上限を設ける
- 管理系ツールは allowlist 制にする

---

## カテゴリJ: 依存関係・サプライチェーン

### J-1 パッケージ追加時の必須確認

- 最終更新日時
- 利用実績
- 既知脆弱性
- メンテ状態
- ライセンス
- タイポスクワッティングの疑い

### J-2 ロックファイル管理

- `package-lock.json` `pnpm-lock.yaml` `poetry.lock` `requirements-lock` 等を適切に管理する
- 本番再現性を重視する
- 依存更新はまとめて雑に行わない

### J-3 自動チェック

- npm audit
- pip-audit
- gitleaks
- license-checker
- SBOM生成

をコミット前またはCIで実行する。

---

## 禁止実装

以下は原則禁止とする。

- ハードコードされた token / secret / webhook
- `eval` `exec` `new Function` の使用
- `shell=True` へユーザー入力を渡すこと
- 権限チェックなしの管理コマンド
- DB文字列連結
- `.env` や設定JSONのGit追跡
- エラー詳細のDiscord返信
- 任意URL fetch
- 無制限の purge / bulk action
- AI出力の自動実行
- 例外処理で握りつぶして黙殺すること
- 本番で debug mode を常時有効化すること
- handler 内へ業務ロジックとDB処理と外部API処理を全部書くこと

---

## 推奨実装パターン

### 共通権限関数を持つ

```ts
export function canManagePunishment(member: GuildMember): boolean {
  return member.permissions.has(PermissionFlagsBits.ModerateMembers);
}
```

### 入力検証関数を共通化する

```py
def validate_reason(text: str) -> str:
    text = text.strip()
    if not text:
        raise ValueError("reason is required")
    if len(text) > 300:
        raise ValueError("reason too long")
    return text
```

### 監査ログを共通化する

```ts
await auditLogRepository.create({
  actorUserId: interaction.user.id,
  targetUserId,
  guildId: interaction.guildId,
  channelId: interaction.channelId,
  action: "timeout_apply",
  reason,
  correlationId,
});
```

### 危険操作は確認フローを挟む

```text
入力受付
  ↓
権限確認
  ↓
対象確認
  ↓
確認UI
  ↓
監査ログ予約
  ↓
実行
  ↓
結果記録
```

---

## コミット前チェックリスト

すべて Yes でなければ原則コミットしない。

1. secret はコードとログに存在しないか
2. 管理機能に権限チェックがあるか
3. 対象ユーザー操作に hierarchy チェックがあるか
4. DBアクセスはプレースホルダ化されているか
5. 外部通信に timeout と制限があるか
6. メンション暴発対策があるか
7. エラー返信に内部情報が含まれていないか
8. 監査ログが記録されるか
9. 高コスト処理にレート制限があるか
10. AI出力やユーザー入力を実行していないか
11. 新規設定値は config 層へ集約されているか
12. 既存の共通関数を再利用しているか
13. テストまたは少なくとも異常系確認をしたか
14. 危険操作は確認ステップがあるか
15. 一時デバッグコードを消したか

---

## 自動チェックコマンド例

```bash
# Secret scan
gitleaks detect --source . --verbose

# Node.js
npm audit --audit-level=moderate

# Python
pip install pip-audit && pip-audit

# ライセンス
npx license-checker --production --summary

# 追跡確認
git check-ignore -v .env

git diff --staged
```

CIに入れる場合も、ローカル確認を省略しない。

---

## 深刻度判定

### 🔴 Critical

- Token漏洩
- 管理コマンド無認可
- 任意コード実行
- SQL injection
- 任意URL SSRF
- AI経由の危険操作自動実行

対応。

- 即修正
- 場合によっては本番停止
- token rotation 実施

### 🟠 High

- 監査ログ欠落の高危険機能
- hierarchy 未確認の処罰機能
- mass mention 誘発
- Webhook 保護不備
- 大量実行上限なし

対応。

- 24時間以内修正

### 🟡 Medium

- 入力長制限不足
- logging 過多
- config 分散
- 例外メッセージの粒度過大

対応。

- 次PRまでに修正

### 🟢 Low

- 可読性改善
- 構造整理
- コメント改善

---

## コミット可否判定

以下の基準で判定する。

- 🔴 が1件でもある → 🚫 NG
- 🟠 が2件以上ある → 🚫 NG
- 🟠 が1件ある → ⚠️ 修正後コミット
- 🟡 のみ → ✅ 条件付きOK
- 🟢 のみ → ✅ OK

ただし、管理機能、認証、トークン、外部送信、AI実行、課金相当処理に関する欠陥は厳しめに判定する。

---

## インシデント初動

### Token や secret が漏洩した場合

1. 直ちに token を再発行し旧 token を無効化する
2. Webhook や API key も同様にローテーションする
3. 漏洩箇所を履歴から除去する
4. 監査ログとアクセスログを確認する
5. 不審操作の有無を点検する
6. 再発防止として secret scan をCIへ追加する

### 危険コマンドが誤実行された場合

1. 実行者、対象、件数、時間を特定する
2. 可能な範囲でロールや設定を復旧する
3. 同一経路の再実行を停止する
4. 監査ログ欠落があれば優先修正する

### AI機能が暴走した場合

1. 自動実行経路を停止する
2. 該当プロンプトとツール呼び出しログを確認する
3. 実行権限を proposal only へ引き下げる
4. 入力サニタイズと確認フローを追加する

---

## 実装時の出力ルール

このスキルを使ってコードを生成・修正・レビューする場合、必ず以下を守る。

- 変更理由より先に安全性を満たす実装を出す
- 新規機能は共通権限関数、共通ロガー、共通バリデータを優先使用する
- 危険操作には確認ステップを含める
- 例外時の返信文は利用者向けに一般化する
- 必要なら audit log まで含めてコードを出す
- 保守のため、単一巨大ファイル化を避ける
- コメントは機能意図を書く。変更説明は書かない
- 暫定回避ではなく恒久的に安全な構造を選ぶ

---

## 最終判断基準

Discord BOT のコードは、以下を同時に満たして初めて「安全に実装された」と見なす。

- 秘密情報が管理されている
- 権限逸脱が防がれている
- ユーザー入力が検証されている
- 危険操作に確認と監査がある
- エラーで内部情報が漏れない
- 将来の追加実装でも同じ安全基準を流用できる

安全性、拡張性、保守性のいずれかを犠牲にする実装は採用しない。

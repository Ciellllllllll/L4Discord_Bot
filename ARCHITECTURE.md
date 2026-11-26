# アーキテクチャ

このリポジトリの`src/`では依存の向きを一方向に保つため、コードを層に分けています。ルールの定義元は[scripts/check-boundaries.mjs](scripts/check-boundaries.mjs)であり、この文書はその内容を説明します。

## 層

```
最下層   core / adapters / vendor / types     共通部品。上の層を知らない
機能層   features/*                            許可リストに従って一方向にだけ依存
入口層   commands / interactions / message     Discordのイベントを機能へ振り分ける
最上層   bot / index.ts / scripts              起動と組み立て、運用スクリプト。すべてを知ってよい
テスト補助 test                                テスト専用の補助処理。最下層だけに依存
```

行にある層が列にある層をimportできるかどうかを、次の表にまとめます。

| import元 \ 先 | 最下層 | features | 入口層 | bot | test |
| --- | --- | --- | --- | --- | --- |
| 最下層 | ○（同層内） | × | × | × | × |
| features | ○ | 許可リストのみ | × | × | × |
| 入口層 | ○ | ○ | ○ | `bot/context.ts` のみ ○ | × |
| bot / index.ts / scripts | ○ | ○ | ○ | ○ | × |
| test | ○ | × | × | × | × |

`*.spec.ts`にも同じ規則を適用します。例外として、`*.spec.ts`からは`src/test/`のテスト補助をimportできます。

## 機能どうしの依存の許可リスト

許可リストの定義元は`scripts/check-boundaries.mjs`の`FEATURE_ALLOWLIST`です。現在許可されている依存の向きは次のとおりです。

```
ai             -> panels, japaneseAnalysis, vc
appeals        -> （なし）
bokeru         -> ai, bokete
detecter       -> appeals
gameDeals      -> epic, steam
linkPreviews   -> ai, steam, youtube
moderation     -> panels
modmail        -> appeals
pacchi         -> ai, japaneseAnalysis
panelHub       -> ai, messageLog, moderation, modmail, panels, reactionRoles, reminders, vc
reactionRoles  -> panels
reminders      -> panels
senryu         -> ai, japaneseAnalysis
utilities      -> ai, linkPreviews
vc             -> panels, messageLog
youtube        -> （なし）
youtubeWatcher -> youtube, linkPreviews
panels         -> （なし）
その他の機能   -> （なし）
```

このリストにない向きの依存は禁止しています。許可リスト自体が循環していないこと（有向非巡回グラフであること）も自動で検査します。依存を増やしたい場合は、まずファイルの置き場所の移動や依存性の逆転で解消してください。

## 依存の受け取り方

機能層の関数は`BotContext`全体を受け取らず、その関数と、そこから呼ぶ関数が実際に使う項目だけを型で受け取ります。

```ts
import type { CoreDeps } from "../../core/deps.js";

type ReminderHubDeps = Pick<CoreDeps, "config" | "log" | "client">;

export async function handleReminderHubButton(interaction: ButtonInteraction, ctx: ReminderHubDeps): Promise<boolean> {
  // ...
}
```

`CoreDeps`は`src/core/deps.ts`に定義しており、最下層の型だけで表せる依存（config、DB、pool、log、client）を持ちます。機能固有の依存（`aiRouter`、`vcTemp`、`vcRanking`など）は、それを使う機能の側で型に追加してください。`config`は読み取り専用のため、`AppConfig`全体を渡して構いません。入口層とbotは構造的部分型によって`BotContext`をそのまま渡せます。

## 確認方法

```sh
npm run lint
```

`npm run lint`はESLintの後に`node scripts/check-boundaries.mjs`を実行します。違反が1件でもあれば終了コード1で終了し、CIでも同じコマンドで検査します。

## チェック項目

違反メッセージの先頭にある`[名前]`が規則名です。

| 規則名 | 内容 |
| --- | --- |
| `layer` | 層の可否表に従うこと。最下層は上の層をimportせず、機能層は`src/bot/`や入口層をimportしない。入口層が`bot/`からimportしてよいのは`bot/context.ts`だけ。`src/test/`は最下層だけをimportし、`*.spec.ts`からだけ参照できる。 |
| `allowlist` | 機能どうしの依存は`FEATURE_ALLOWLIST`にある向きだけに限定する。 |
| `allowlist-cycle` | 許可リスト自身が循環していないこと。 |
| `file-cycle` | ファイル単位の循環importがないこと。type-only importも依存辺として数える。 |
| `max-lines` | `*.spec.ts`以外の`src/**/*.ts`は500行以下に収める。分割で新しく作るファイルは400行以下を目安にする。 |
| `resolve` | 相対importが`src/`内の実ファイルに解決できること。 |

上記の自動検査とは別に、機能層では`BotContext`全体ではなく実際に使う項目だけを`CoreDeps`からの`Pick`などで受け取る規約を運用しています。

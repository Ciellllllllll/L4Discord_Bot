export const BOT_SEMVER = "2.0.2";

// スラッシュコマンド名 → 利用に必要な最低 BOT_SEMVER

export const SLASH_COMMAND_MIN_BOT_VERSION: Record<string, string> = {
  q: "0.1.0",
  ping: "0.1.0",
  vc_rank: "0.1.0",
  create_werewolfgame: "2.1.0",
  end_werewolfgame: "2.1.0",
  処刑: "0.1.0",
  タイムアウト延長: "0.1.0",
  disable_emoji: "0.1.0",
  enable_emoji: "0.1.0",
  stamp_rank: "0.1.0",
  change_prompt: "2.0.1",
  mute: "2.0.1",
};

// プレフィックスコマンド（小文字キー）→ 利用に必要な最低 BOT_SEMVER

export const PREFIX_COMMAND_MIN_BOT_VERSION: Record<string, string> = {
  setup: "0.1.0",
  reload: "0.1.0",
  start: "2.1.0",
  kill: "2.1.0",
  guard: "2.1.0",
  see: "2.1.0",
  reply: "0.1.0",
  nolog: "0.1.0",
};

// 常設パネル（panel_kind）ごとの UI 論理バージョン。
// DB に保存された値と一致し、かつメッセージが生きていれば再送信・編集しない。
// レイアウト変更時はここだけ上げると次回起動で編集反映される。

export const PERMANENT_UI_VERSION: Record<string, string> = {
  vc_creator: "1.0.0",
  reaction_role_admin: "1.0.0",
  message_log_panel: "1.0.0",
  user_contact_panel: "1.0.0",
  ai_query_history_admin: "1.0.0",
  reminder_hub: "1.0.0",
  automod_panel: "1.0.0",
};

export function getPermanentUiVersion(panelKind: string): string {
  return PERMANENT_UI_VERSION[panelKind] ?? "1.0.0";
}

// 起動ログ・スラッシュ同期ログ用（DB/JSON ではなくコード由来の版情報）

export function getReleaseBundleForLog(): {
  botSemver: string;
  slashCommandMinBotVersion: Record<string, string>;
  prefixCommandMinBotVersion: Record<string, string>;
  permanentUiVersion: Record<string, string>;
} {
  return {
    botSemver: BOT_SEMVER,
    slashCommandMinBotVersion: { ...SLASH_COMMAND_MIN_BOT_VERSION },
    prefixCommandMinBotVersion: { ...PREFIX_COMMAND_MIN_BOT_VERSION },
    permanentUiVersion: { ...PERMANENT_UI_VERSION },
  };
}

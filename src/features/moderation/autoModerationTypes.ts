// DiscordBOTv2 AutoModeration.js と同一の設定キー

export type AutoModSettings = {
  enabled: boolean;
  linkBlock: boolean;
  inviteBlock: boolean;
  spamBlock: boolean;
  raidMode: boolean;
  spamWindowSec: number;
  spamThreshold: number;
  timeoutSec: number;
    // 空文字はモッドログなし（既定は env のログチャンネル）

  modlogChannelId: string;
};

export const AUTOMOD_SELECT_PREFIX = "automod_select:";
export const AUTOMOD_RAID_CONFIRM_PREFIX = "automod_raid_confirm:";
export const AUTOMOD_RAID_CANCEL_PREFIX = "automod_raid_cancel:";

export const PANEL_TOGGLE_OPTIONS: readonly {
  key: keyof Pick<
    AutoModSettings,
    "enabled" | "linkBlock" | "inviteBlock" | "spamBlock" | "raidMode"
  >;
  label: string;
  description: string;
}[] = [
  {
    key: "enabled",
    label: "全体を有効化",
    description: "自動モデレーション全体をONにします",
  },
  {
    key: "linkBlock",
    label: "外部リンク投稿をブロック",
    description: "http/https の外部リンク投稿を削除対象にします",
  },
  {
    key: "inviteBlock",
    label: "招待リンク投稿をブロック",
    description: "Discord 招待リンクを削除対象にします",
  },
  {
    key: "spamBlock",
    label: "連投スパムをブロック",
    description: "短時間の連続投稿を検知して対応します",
  },
  {
    key: "raidMode",
    label: "Raidモードを有効化",
    description: "荒らし対策の緊急モードです（変更時は確認が必要）",
  },
] as const;

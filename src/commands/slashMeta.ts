export type SlashCommandMeta = {
  name: string;
  introducedIn: string;
};

export const SLASH_META: Record<string, SlashCommandMeta> = {
  q: { name: "q", introducedIn: "0.1.0" },
  ping: { name: "ping", introducedIn: "0.1.0" },
  member_count_setup: { name: "member_count_setup", introducedIn: "0.1.0" },
  vc_rank: { name: "vc_rank", introducedIn: "0.1.0" },
  create_werewolfgame: { name: "create_werewolfgame", introducedIn: "0.1.0" },
  end_werewolfgame: { name: "end_werewolfgame", introducedIn: "0.1.0" },
  処刑: { name: "処刑", introducedIn: "0.1.0" },
  タイムアウト延長: { name: "タイムアウト延長", introducedIn: "0.1.0" },
  disable_emoji: { name: "disable_emoji", introducedIn: "0.1.0" },
  enable_emoji: { name: "enable_emoji", introducedIn: "0.1.0" },
  stamp_count: { name: "stamp_count", introducedIn: "0.1.0" },
  stamp_ranking: { name: "stamp_ranking", introducedIn: "0.1.0" },
};

export type VcRankPeriod = "day" | "week" | "month" | "all";

export type VcRankEntry = {
  userId: string;
  seconds: number;
};

export interface IVcRankingRepository {
  getRanking(guildId: string, period: VcRankPeriod): Promise<VcRankEntry[]>;
}

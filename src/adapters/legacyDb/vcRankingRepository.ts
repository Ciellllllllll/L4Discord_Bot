export type VcRankPeriod = "day" | "week" | "month" | "all";

export type VcRankEntry = {
  userId: string;
  seconds: number;
};

export interface IVcRankingRepository {
  getRanking(guildId: string, period: VcRankPeriod): Promise<VcRankEntry[]>;
}

export class NoOpVcRankingRepository implements IVcRankingRepository {
  async getRanking(_guildId: string, _period: VcRankPeriod): Promise<VcRankEntry[]> {
    return [];
  }
}

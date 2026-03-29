export type MessageLogSearchParams = {
  guildId: string;
  query: string;
  limit: number;
};

export type MessageLogHit = {
  id: string;
  channelId: string;
  authorId: string;
  snippet: string;
  createdAt: string;
};

export interface IMessageLogRepository {
  search(params: MessageLogSearchParams): Promise<MessageLogHit[]>;
}

export class NoOpMessageLogRepository implements IMessageLogRepository {
  async search(_params: MessageLogSearchParams): Promise<MessageLogHit[]> {
    return [];
  }
}

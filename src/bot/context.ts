import type { Client } from "discord.js";
import type { Kysely } from "kysely";
import type pino from "pino";
import type { Pool } from "pg";
import type { AppConfig } from "../core/config.js";
import type { AiHistoryDatabase, AutomoderationDatabase, Database, TicketDatabase } from "../core/db/types.js";
import type { IVcRankingRepository } from "../adapters/legacyDb/vcRankingRepository.js";
import type { VcTemporaryChannelManager } from "../features/vc/vcTemporaryChannelManager.js";
import type { AiProviderRouter } from "../features/ai/aiProviderRouter.js";

export type BotContext = {
  config: AppConfig;
  db: Kysely<Database>;
  ticketDb: Kysely<TicketDatabase>;
  messageLogPgPool: Pool;
  messageAttachmentPgPool: Pool;
  vcTimePgPool: Pool;
  aiHistoryDb: Kysely<AiHistoryDatabase>;
  automodDb: Kysely<AutomoderationDatabase>;
  log: pino.Logger;
  client: Client;
  aiRouter: AiProviderRouter;
  mainPgPool: Pool;
  vcRanking: IVcRankingRepository;
  vcTemp: VcTemporaryChannelManager;
};

import type { Client } from "discord.js";
import type { Kysely } from "kysely";
import type pino from "pino";
import type { AppConfig } from "../core/config.js";
import type { Database } from "../core/db/types.js";
import type { IMessageLogRepository } from "../adapters/legacyDb/messageLogRepository.js";
import type { IVcRankingRepository } from "../adapters/legacyDb/vcRankingRepository.js";

export type BotContext = {
  config: AppConfig;
  db: Kysely<Database>;
  log: pino.Logger;
  client: Client;
  messageLog: IMessageLogRepository;
  vcRanking: IVcRankingRepository;
};

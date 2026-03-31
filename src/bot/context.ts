import type { Client } from "discord.js";
import type DatabaseLib from "better-sqlite3";
import type { Kysely } from "kysely";
import type pino from "pino";
import type { AppConfig } from "../core/config.js";
import type { Database, TicketDatabase } from "../core/db/types.js";
import type { IVcRankingRepository } from "../adapters/legacyDb/vcRankingRepository.js";
import type { VcTemporaryChannelManager } from "../features/vc/vcTemporaryChannelManager.js";

export type BotContext = {
  config: AppConfig;
  db: Kysely<Database>;
  sqlite: DatabaseLib.Database;
  /** Modmail / 異議申し立て / 汎用 tickets（ticket.db） */
  ticketDb: Kysely<TicketDatabase>;
  ticketSqlite: DatabaseLib.Database;
  /** メッセージログ専用（message.db） */
  messageLogSqlite: DatabaseLib.Database;
  /** VC 滞在時間（sessions）専用（vc_time.db） */
  vcTimeSqlite: DatabaseLib.Database;
  log: pino.Logger;
  client: Client;
  vcRanking: IVcRankingRepository;
  vcTemp: VcTemporaryChannelManager;
};

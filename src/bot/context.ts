import type { Client } from "discord.js";
import type DatabaseLib from "better-sqlite3";
import type { Kysely } from "kysely";
import type pino from "pino";
import type { Pool } from "pg";
import type { AppConfig } from "../core/config.js";
import type { AiHistoryDatabase, AutomoderationDatabase, Database, TicketDatabase } from "../core/db/types.js";
import type { IVcRankingRepository } from "../adapters/legacyDb/vcRankingRepository.js";
import type { VcTemporaryChannelManager } from "../features/vc/vcTemporaryChannelManager.js";
import type { AiProviderRouter } from "../features/ai/aiProviderRouter.js";

export type RuntimeSqlDatabase = DatabaseLib.Database;

export type BotContext = {
  config: AppConfig;
  db: Kysely<Database>;
  sqlite?: RuntimeSqlDatabase;
  // Modmail / 異議申し立て / 汎用 tickets（ticket.db）

  ticketDb: Kysely<TicketDatabase>;
  ticketSqlite?: RuntimeSqlDatabase;
  // メッセージログ専用（message.db）

  messageLogSqlite?: RuntimeSqlDatabase;
  messageLogPgPool?: Pool;
  // 添付ローカル複製のメタ（message_attachment_store.db）。message.db とは別ファイル

  messageAttachmentStoreSqlite?: RuntimeSqlDatabase;
  messageAttachmentPgPool?: Pool;
  // VC 滞在時間（sessions）専用（vc_time.db）

  vcTimeSqlite?: RuntimeSqlDatabase;
  // /q 会話履歴（AI_History.db）

  aiHistoryDb: Kysely<AiHistoryDatabase>;
  aiHistorySqlite?: RuntimeSqlDatabase;
  // 自動モデレーション設定（Automoderation.db）

  automodDb: Kysely<AutomoderationDatabase>;
  automodSqlite?: RuntimeSqlDatabase;
  log: pino.Logger;
  client: Client;
  aiRouter: AiProviderRouter;
  gameDealPgPool?: Pool;
  vcRanking: IVcRankingRepository;
  vcTemp: VcTemporaryChannelManager;
};

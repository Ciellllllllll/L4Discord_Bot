import type { Client } from "discord.js";
import type { Kysely } from "kysely";
import type pino from "pino";
import type { Pool } from "pg";
import type { AppConfig } from "./config.js";
import type { AiHistoryDatabase, AutomoderationDatabase, Database, TicketDatabase } from "./db/types.js";

// 機能層が受け取る依存のうち、最下層の型だけで表せる項目。
// 機能固有の依存 (aiRouter など) は、それを使う機能の側で型に足す。
export type CoreDeps = {
  config: AppConfig;
  db: Kysely<Database>;
  ticketDb: Kysely<TicketDatabase>;
  aiHistoryDb: Kysely<AiHistoryDatabase>;
  automodDb: Kysely<AutomoderationDatabase>;
  mainPgPool: Pool;
  messageLogPgPool: Pool;
  messageAttachmentPgPool: Pool;
  vcTimePgPool: Pool;
  log: pino.Logger;
  client: Client;
};

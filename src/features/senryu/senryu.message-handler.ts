import type { Message } from "discord.js";
import type DatabaseLib from "better-sqlite3";
import type { Pool } from "pg";
import type { BotContext } from "../../bot/context.js";
import { createPostgresSenryuRepository, createSenryuRepository, type SenryuRepository } from "./senryu.repository.js";
import { runSenryuPipeline } from "./senryu.service.js";

let repo: SenryuRepository | null = null;

export function bindSenryuRepository(sqlite: DatabaseLib.Database): void {
  repo = createSenryuRepository(sqlite);
}

export function bindPostgresSenryuRepository(pool: Pool): void {
  repo = createPostgresSenryuRepository(pool);
}

// @returns true なら川柳として処理済み（reply 有無は設定による）。messageCreate で後続をスキップする用途。

export async function handleSenryuMessage(ctx: BotContext, message: Message): Promise<boolean> {
  if (!repo) {
    ctx.log.error({}, "senryu repository not bound");
    return false;
  }
  try {
    return await runSenryuPipeline(ctx, message, repo);
  } catch (err) {
    ctx.log.error({ err }, "handleSenryuMessage unexpected error");
    return false;
  }
}

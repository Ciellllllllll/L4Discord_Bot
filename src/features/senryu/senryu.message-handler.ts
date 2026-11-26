import type { Message } from "discord.js";
import type { Pool } from "pg";
import type { CoreDeps } from "../../core/deps.js";
import type { AiProviderRouter } from "../ai/aiProviderRouter.js";
import { createPostgresSenryuRepository, type SenryuRepository } from "./senryu.repository.js";
import { runSenryuPipeline } from "./senryu.service.js";

// SenryuMessage が使う依存。
type SenryuMessageDeps = Pick<CoreDeps, "config" | "db" | "log" | "client"> & { aiRouter: AiProviderRouter };

let repo: SenryuRepository | null = null;

export function bindPostgresSenryuRepository(pool: Pool): void {
  repo = createPostgresSenryuRepository(pool);
}

// @returns true なら川柳として処理済み（reply 有無は設定による）。messageCreate で後続をスキップする用途。

export async function handleSenryuMessage(ctx: SenryuMessageDeps, message: Message): Promise<boolean> {
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

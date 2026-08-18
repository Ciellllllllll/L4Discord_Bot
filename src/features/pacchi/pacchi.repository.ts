import type { BotContext } from "../../bot/context.js";
import { PostgresPacchiRepository } from "./postgresPacchiRepository.js";

export type PacchiRepositoryLike = PostgresPacchiRepository;

export function createPacchiRepositoryForContext(ctx: BotContext): PostgresPacchiRepository {
  return new PostgresPacchiRepository(ctx.mainPgPool);
}

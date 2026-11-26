import type { CoreDeps } from "../../core/deps.js";
import { PostgresPacchiRepository } from "./postgresPacchiRepository.js";

// PacchiRepository が使う依存。
type PacchiRepositoryDeps = Pick<CoreDeps, "mainPgPool">;

export type PacchiRepositoryLike = PostgresPacchiRepository;

export function createPacchiRepositoryForContext(ctx: PacchiRepositoryDeps): PostgresPacchiRepository {
  return new PostgresPacchiRepository(ctx.mainPgPool);
}

import type { AppConfig } from "../../core/config.js";
import { containsUnsafeText } from "./pacchi.filters.js";
import { buildPacchiGeneratedReply } from "./pacchi.generator.js";
import type { PacchiRepositoryLike } from "./pacchi.repository.js";
import { isSafePacchiReply } from "./pacchi.safety.js";

type Options = Pick<AppConfig, "PACCHI_GENERATION_MODE" | "PACCHI_TINY_AI_URL" | "PACCHI_TINY_AI_TIMEOUT_MS">;
type Logger = { warn: (fields: Record<string, unknown>, message: string) => void };

// Only one request per bot process. The service also rejects concurrent work.
let inFlight = false;

export function tinyAiPrompt(content: string): string {
  const text = content.replaceAll("ぱっちぃ", "").replace(/\s+/gu, " ").trim();
  if (containsUnsafeText(text)) return "";
  return Array.from(text).slice(0, 48).join("");
}

export async function buildPacchiChatReply(
  repo: PacchiRepositoryLike,
  guildId: string,
  config: Options,
  content: string,
  log: Logger,
  preferWord = false,
): Promise<string> {
  if (config.PACCHI_GENERATION_MODE !== "tiny-ai") {
    return buildPacchiGeneratedReply(repo, guildId, config.PACCHI_GENERATION_MODE, preferWord);
  }
  const fallback = () => buildPacchiGeneratedReply(repo, guildId, "template", preferWord);
  if (inFlight) return fallback();
  inFlight = true;
  try {
    const prompt = tinyAiPrompt(content);
    const response = await fetch(new URL("/generate", config.PACCHI_TINY_AI_URL), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
      signal: AbortSignal.timeout(config.PACCHI_TINY_AI_TIMEOUT_MS),
    });
    if (!response.ok) {
      log.warn({ status: response.status }, "pacchi tiny AI unavailable; using template");
      return fallback();
    }
    const data: unknown = await response.json();
    const text = data && typeof data === "object" && "text" in data && typeof data.text === "string"
      ? data.text.trim() : "";
    if (text && text !== prompt && isSafePacchiReply(text) && !containsUnsafeText(text)) {
      return text;
    }
    log.warn({}, "pacchi tiny AI returned unusable text; using template");
    return fallback();
  } catch {
    // Do not log a prompt, model output, credential-bearing URL or response body.
    log.warn({}, "pacchi tiny AI request failed; using template");
    return fallback();
  } finally {
    inFlight = false;
  }
}

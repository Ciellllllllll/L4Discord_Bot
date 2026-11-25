import type { AiProviderRouter } from "./aiProviderRouter.js";
import type { ChatMessage } from "./chatTypes.js";
import type { AiHistoryStore } from "./aiHistoryStore.js";
import type { UserPromptStore } from "./userPromptStore.js";

export type PromptOptimizerConfig = {
  enabled: boolean;
  minMessages: number;
  intervalMessages: number;
  maxHistory: number;
  temperature: number;
};

export type OptimizeUserPromptDeps = {
  config: PromptOptimizerConfig;
  aiRouter: Pick<AiProviderRouter, "chat">;
  historyStore: AiHistoryStore;
  promptStore: UserPromptStore;
  warn: (meta: Record<string, unknown>, message: string) => void;
};

const optimizingUsers = new Set<string>();

export function shouldOptimizePrompt(historyRowCount: number, config: PromptOptimizerConfig): boolean {
  if (!config.enabled) return false;
  if (!Number.isFinite(historyRowCount) || historyRowCount < config.minMessages) return false;
  return historyRowCount % config.intervalMessages === 0;
}

export async function optimizeUserPromptFromHistory(
  deps: OptimizeUserPromptDeps,
  guildId: string,
  userId: string,
  resolvedUserName: string,
): Promise<void> {
  const uid = String(userId);
  if (optimizingUsers.has(uid)) return;

  optimizingUsers.add(uid);
  try {
    const promptUpdatedAt = deps.promptStore.updatedAt(uid, resolvedUserName);
    const historyCountSincePrompt = await deps.historyStore.countSince(guildId, uid, promptUpdatedAt, "optimizer");
    if (!shouldOptimizePrompt(historyCountSincePrompt, deps.config)) return;

    const { resolved: basePrompt } = deps.promptStore.refreshBasePrompt();
    const currentPrompt = deps.promptStore.load(uid, resolvedUserName);
    const historyWindow = await deps.historyStore.loadWindowForOptimizer(
      guildId,
      uid,
      promptUpdatedAt,
      deps.config.maxHistory,
    );
    const valid = historyWindow.filter(
      (x) => x && (x.role === "user" || x.role === "assistant") && typeof x.content === "string",
    );

    const optimizerMessages: ChatMessage[] = [
      {
        role: "system",
        content: [
          "You are Chat Monitor AI. Rewrite a user-specific system prompt for another assistant. Keep the base prompt intent and safety constraints, personalize tone and phrasing from dialogue history, and return plain prompt text only.",
          "Preserve explicit character/persona facts from the current user prompt exactly, including name, gender, age, romantic or sexual target, background, personality, and speech style. Do not infer a different persona from conversation history.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          "Update the prompt using the history JSON below.",
          "Output only the full rewritten prompt text. No markdown, no code fences.",
          "",
          "[BasePrompt]",
          basePrompt,
          "",
          "[CurrentUserPrompt]",
          currentPrompt,
          "",
          "[ConversationHistoryJSON]",
          JSON.stringify(valid, null, 2),
        ].join("\n"),
      },
    ];

    const { content: optimized } = await deps.aiRouter.chat(guildId, "prompt_optimizer", optimizerMessages, {
      temperature: deps.config.temperature,
      sanitizeOutput: false,
      thinking: false,
    });

    if (!String(optimized || "").trim()) return;
    deps.promptStore.save(uid, resolvedUserName, optimized);
  } catch (err) {
    deps.warn({ err: String(err) }, "prompt optimizer failed");
  } finally {
    optimizingUsers.delete(uid);
  }
}

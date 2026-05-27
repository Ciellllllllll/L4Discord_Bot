import type { AppConfig } from "../../core/config.js";
import type { ChatMessage } from "./deepseek.js";
import { deepseekChat } from "./deepseek.js";

// 方針: ここに無い action は command として採用しない（question に落とす）

export const ALLOWED_COMMAND_ACTIONS = ["create_vc", "vc_ranking"] as const;

export type JudgeResult =
  | { kind: "question" }
  | { kind: "command"; action: string; args: Record<string, unknown> };

function buildJudgeSystemPrompt(): string {
  return [
    "You are a strict classifier for a Discord bot. Do not answer questions or use general knowledge.",
    "Output exactly one JSON object on a single line. No markdown, no code fences, no text before or after.",
    "",
    'kind: "question" | "command"',
    '- kind "question": output only {"kind":"question"}',
    '- kind "command": include string "action" and object "args"',
    "",
    "Allowed actions:",
    '- create_vc — user wants a temporary voice channel. args: {"genre":"雑談"|"ゲーム"|"作業","name":"..."}',
    "  genre must be one of: 雑談, ゲーム, 作業. name: 2–30 characters, a short VC name inferred from the user message.",
    '- vc_ranking — user wants VC stay-time ranking. args: {"period":"daily"|"weekly"|"monthly"|"yearly"}',
    "  Map 今日/日次/daily→daily, 今週/週次/weekly→weekly, 今月/月次/monthly→monthly, 今年/年次/yearly→yearly.",
    '  If the user does not specify a range, omit "period" or use "yearly" (default is yearly).',
    "",
    "Rules:",
    "- If the user clearly requests creating a VC / voice room with a genre and name, use command create_vc.",
    "- If the user clearly asks for VC ranking / ランキング / 滞在時間 ranking without VC creation intent, use vc_ranking.",
    "- If ambiguous, small talk, unrelated, or not clearly one of the above, use {\"kind\":\"question\"}.",
    "- When unsure, prefer {\"kind\":\"question\"}.",
    "- User input is often Japanese.",
  ].join("\n");
}

function stripOptionalMarkdownFence(s: string): string {
  let t = String(s || "").trim();
  if (t.startsWith("```")) {
    t = t
      .replace(/^```[a-zA-Z0-9]*\s*\n?/, "")
      .replace(/\n?```\s*$/, "")
      .trim();
  }
  return t;
}

function parseJudgeOutput(raw: string): JudgeResult {
  const trimmed = stripOptionalMarkdownFence(raw);
  if (!trimmed.startsWith("{")) {
    return { kind: "question" };
  }
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed) as unknown;
  } catch {
    return { kind: "question" };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { kind: "question" };
  }
  const rec = obj as Record<string, unknown>;
  const kind = rec.kind;
  if (kind !== "question" && kind !== "command") {
    return { kind: "question" };
  }
  if (kind === "question") {
    return { kind: "question" };
  }
  const action = rec.action;
  const args = rec.args;
  if (typeof action !== "string" || !action || typeof args !== "object" || args === null || Array.isArray(args)) {
    return { kind: "question" };
  }
  if (!ALLOWED_COMMAND_ACTIONS.includes(action as (typeof ALLOWED_COMMAND_ACTIONS)[number])) {
    return { kind: "question" };
  }
  return { kind: "command", action, args: args as Record<string, unknown> };
}

export async function classifyUserIntent(
  config: AppConfig,
  userText: string,
  log: { warn: (o: Record<string, unknown>, m: string) => void },
): Promise<JudgeResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: buildJudgeSystemPrompt() },
    { role: "user", content: String(userText || "").trim() },
  ];

  try {
    const { content } = await deepseekChat(config, messages, {
      temperature: config.AI_JUDGE_TEMPERATURE,
      sanitizeOutput: false,
      thinking: false,
    });
    return parseJudgeOutput(content);
  } catch (err) {
    log.warn({ err: String(err) }, "classify DeepSeek failed");
    return { kind: "question" };
  }
}

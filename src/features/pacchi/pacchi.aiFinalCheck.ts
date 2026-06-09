import type { AppConfig } from "../../core/config.js";
import { deepseekChat, type ChatMessage } from "../ai/deepseek.js";

export type PacchiAiFinalCheckVerdict = "accept" | "reject";

export function parsePacchiAiFinalCheckVerdict(raw: string): PacchiAiFinalCheckVerdict | null {
  const trimmed = raw.trim().replace(/^```[a-zA-Z0-9]*\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as { verdict?: unknown };
    return parsed.verdict === "accept" || parsed.verdict === "reject" ? parsed.verdict : null;
  } catch {
    return null;
  }
}

export async function pacchiAiFinalCheck(
  config: AppConfig,
  log: { warn: (o: Record<string, unknown>, m: string) => void },
  reply: string,
): Promise<boolean> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "あなたはDiscord bot「ぱっちぃ」の返信を安全確認する最終フィルタです。",
        "返信を生成してはいけません。入力された返信案を accept または reject で判定してください。",
        "mention、URL、個人情報らしき内容、攻撃的表現、ユーザーを馬鹿にする表現、ネットスラングの「草」は reject。",
        "短く無害で、断定が弱く、ユーザーを攻撃しない返信は accept。",
        "出力は1行JSONのみ。",
        '{"verdict":"accept"} または {"verdict":"reject"}',
      ].join("\n"),
    },
    { role: "user", content: reply },
  ];

  try {
    const result = await deepseekChat(config, messages, {
      temperature: 0,
      thinking: false,
      sanitizeOutput: false,
      timeoutMs: Math.min(config.AI_REQUEST_TIMEOUT_MS, 8_000),
      maxRetries: 0,
    });
    const verdict = parsePacchiAiFinalCheckVerdict(result.content);
    if (!verdict) {
      log.warn({ raw: result.content.slice(0, 200) }, "pacchi ai final check: unparseable verdict");
      return false;
    }
    return verdict === "accept";
  } catch (err) {
    log.warn({ err: String(err) }, "pacchi ai final check failed");
    return false;
  }
}

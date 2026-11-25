import { stripOptionalMarkdownFence } from "../../core/text.js";
import type { AiProviderRouter } from "../ai/aiProviderRouter.js";
import type { ChatMessage } from "../ai/chatTypes.js";

export type PacchiAiFinalCheckVerdict = "accept" | "reject";

export function parsePacchiAiFinalCheckVerdict(raw: string): PacchiAiFinalCheckVerdict | null {
  const trimmed = stripOptionalMarkdownFence(raw);
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as { verdict?: unknown };
    return parsed.verdict === "accept" || parsed.verdict === "reject" ? parsed.verdict : null;
  } catch {
    return null;
  }
}

export async function pacchiAiFinalCheck(
  router: AiProviderRouter,
  guildId: string,
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
    const result = await router.chat(guildId, "pacchi_final_check", messages, {
      temperature: 0,
      thinking: false,
      sanitizeOutput: false,
    });
    const verdict = parsePacchiAiFinalCheckVerdict(result.content);
    if (!verdict) {
      log.warn({}, "pacchi ai final check: unparseable verdict");
      return false;
    }
    return verdict === "accept";
  } catch (err) {
    log.warn({ err: String(err) }, "pacchi ai final check failed");
    return false;
  }
}

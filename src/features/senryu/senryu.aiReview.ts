import type { AppConfig } from "../../core/config.js";
import type { ChatMessage } from "../ai/deepseek.js";
import { deepseekChat } from "../ai/deepseek.js";
import { resolveReading } from "./senryu.kuromoji.js";
import type { KuromojiToken, SenryuCandidate } from "./senryu.types.js";

export type SenryuAiReviewVerdict = "accept" | "reject";

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

/** 単体テスト用 */
export function parseSenryuAiReviewVerdict(raw: string): SenryuAiReviewVerdict | null {
  const trimmed = stripOptionalMarkdownFence(raw);
  if (!trimmed.startsWith("{")) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const v = (obj as Record<string, unknown>).verdict;
  if (v === "accept" || v === "reject") return v;
  return null;
}

/**
 * kuromoji トークン列のうち検出区間だけを、API 入力向けに短く整形する（Kagome の生 JSON は送らない）。
 */
export function formatKuromojiSpanForAiReview(tokens: KuromojiToken[], candidate: SenryuCandidate): string {
  const { start, end } = candidate.tokenSpan;
  const slice = tokens.slice(Math.max(0, start), Math.min(tokens.length, end));
  const lines = slice.map((t) => {
    const r = resolveReading(t);
    const reading = r ?? (t.reading.trim() || t.surface);
    const pos = t.pos[0] ?? "*";
    return `${t.surface}\t${reading}\t${pos}`;
  });
  return [
    `候補: ${candidate.formatted}`,
    "形態素（表層形<TAB>読み/表記<TAB>品詞大分類）:",
    ...lines,
  ].join("\n");
}

function buildSenryuReviewSystemPrompt(): string {
  return [
    "あなたは日本語川柳（5-7-5）の最終フィルタです。",
    "入力は形態素解析器 kuromoji の結果のみです（読みは参考。機械的な5-7-5と人間の感覚は一致しないことがあります）。",
    "",
    "次の場合は verdict を reject にしてください:",
    "- 意味のない記号・数字・英単語の羅列、明らかなノイズ",
    "- 不自然な途中切れで無理やり5-7-5に見せている",
    "- 川柳・短文として成立していないと判断できる",
    "",
    "自然な短文・俳句調・口語的な川柳であれば accept でもよいです。",
    "",
    "出力は1行の JSON のみ。前後に説明やマークダウン禁止。",
    '{"verdict":"accept"} または {"verdict":"reject"}',
  ].join("\n");
}

export type SenryuAiReviewResult =
  | { ok: true; verdict: SenryuAiReviewVerdict; ms: number }
  | { ok: false; err: string };

/**
 * DeepSeek（既存の OpenAI 互換エンドポイント）で候補を審査する。
 */
export async function reviewSenryuCandidateWithAi(
  config: AppConfig,
  log: { warn: (o: Record<string, unknown>, m: string) => void },
  userBlock: string,
): Promise<SenryuAiReviewResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: buildSenryuReviewSystemPrompt() },
    { role: "user", content: userBlock },
  ];

  try {
    const model = config.SENRYU_AI_REVIEW_MODEL ?? config.DEEPSEEK_MODEL;
    const { content, ms } = await deepseekChat(config, messages, {
      model,
      temperature: config.SENRYU_AI_REVIEW_TEMPERATURE,
      sanitizeOutput: false,
      timeoutMs: config.SENRYU_AI_REVIEW_TIMEOUT_MS,
      maxRetries: config.SENRYU_AI_REVIEW_MAX_RETRIES,
    });
    const verdict = parseSenryuAiReviewVerdict(content);
    if (!verdict) {
      log.warn({ raw: content.slice(0, 200) }, "senryu ai review: unparseable verdict");
      return { ok: false, err: "unparseable_verdict" };
    }
    return { ok: true, verdict, ms };
  } catch (err) {
    log.warn({ err: String(err) }, "senryu ai review: DeepSeek failed");
    return { ok: false, err: "request_failed" };
  }
}

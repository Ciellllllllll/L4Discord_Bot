import type { AppConfig } from "../../core/config.js";
import type { AiProviderRouter } from "../ai/aiProviderRouter.js";
import type { ChatMessage } from "../ai/chatTypes.js";
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

// 単体テスト用

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

// kuromoji トークン列のうち検出区間だけを、API 入力向けに短く整形する（Kagome の生 JSON は送らない）。

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

export function formatSenryuMorphemeTableForAiReview(tokens: KuromojiToken[], candidate: SenryuCandidate): string {
  const { start, end } = candidate.tokenSpan;
  const slice = tokens.slice(Math.max(0, start), Math.min(tokens.length, end));
  const lines = slice.map((t) => {
    const r = resolveReading(t);
    const reading = r ?? (t.reading.trim() || t.surface);
    const pos = t.pos[0] ?? "*";
    return `${t.surface}\t${reading}\t${pos}`;
  });
  return ["形態素（表層形<TAB>読み/表記<TAB>品詞大分類）:", ...lines].join("\n");
}

export function buildSenryuAiReviewUserBlock(
  contextExcerpt: string,
  tokens: KuromojiToken[],
  candidate: SenryuCandidate,
): string {
  return [
    "周辺文脈（正規化テキストの抜粋。Discord等の雑談の一部です）:",
    contextExcerpt,
    "",
    "検出した三拍子:",
    `上句: ${candidate.kamigo}`,
    `中句: ${candidate.nakashichi}`,
    `下句: ${candidate.shimogo}`,
    "",
    formatSenryuMorphemeTableForAiReview(tokens, candidate),
  ].join("\n");
}

function buildSenryuReviewSystemPrompt(): string {
  return [
    "あなたは、Discord 等の雑談・業務メッセージの中から「5・7・5 に近い三拍子」を拾うためのフィルタです。",
    "伝統的な川柳の鑑定（季語・切字・各句の百科的完結）は求めません。",
    "川柳鑑定時は一度漢字等をすべてひらがなに崩し、5・7・5のリズムにできるだけノッているかの確認をして下さい。",
    "「っ」「ゃ」「ゅ」「ょ」などの小さい音は時として0文字として扱われる場合もあります。ひらがなに分解した際に0文字の可能性がないかしっかりとチェックして下さい。",
    "",
    "入力の「上句・中句・下句」と形態素は、機械的な候補です。口語・カタカナ・業務用語はそのまま前提です。",
    "",
    "verdict は原則 accept にしてください。reject にしてよいのは次のような明らかなケースに限定します:",
    "- 記号・数字・英単語の羅列など、明らかなノイズやスパム",
    "- 三拍子として日本語がほとんど成立せず、読み物として意味が通らない",
    "- 川柳を声に出して詠んだ際明らかにリズムが狂う語数5・9・5等の場合はrejectして下さい",
    "",
    "取りこぼしを減らすため、迷った場合や微妙な場合は必ず accept にしてください。",
    "",
    "出力は1行の JSON のみ。前後に説明やマークダウン禁止。",
    '{"verdict":"accept"} または {"verdict":"reject"}',
  ].join("\n");
}

export type SenryuAiReviewResult =
  | { ok: true; verdict: SenryuAiReviewVerdict; ms: number }
  | { ok: false; err: string };

// 選択中のAI providerで候補を審査する。

export async function reviewSenryuCandidateWithAi(
  config: AppConfig,
  router: AiProviderRouter,
  guildId: string,
  log: { warn: (o: Record<string, unknown>, m: string) => void },
  userBlock: string,
): Promise<SenryuAiReviewResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: buildSenryuReviewSystemPrompt() },
    { role: "user", content: userBlock },
  ];

  try {
    const { content, ms } = await router.chat(guildId, "senryu_review", messages, {
      temperature: config.SENRYU_AI_REVIEW_TEMPERATURE,
      sanitizeOutput: false,
      thinking: false,
      timeoutMs: config.SENRYU_AI_REVIEW_TIMEOUT_MS,
      maxRetries: config.SENRYU_AI_REVIEW_MAX_RETRIES,
    });
    const verdict = parseSenryuAiReviewVerdict(content);
    if (!verdict) {
      log.warn({}, "senryu ai review: unparseable verdict");
      return { ok: false, err: "unparseable_verdict" };
    }
    return { ok: true, verdict, ms };
  } catch (err) {
    log.warn({ err: String(err) }, "senryu ai review failed");
    return { ok: false, err: "request_failed" };
  }
}

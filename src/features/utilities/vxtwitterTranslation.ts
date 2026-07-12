import type { AppConfig } from "../../core/config.js";
import { deepseekChat, type ChatMessage, type DeepSeekResult } from "../ai/deepseek.js";
import type { AiProviderRouter } from "../ai/aiProviderRouter.js";

const MIN_CONFIDENCE = 0.75;

export type TranslationDecision = {
  shouldTranslate: boolean;
  sourceLanguage: string;
  confidence: number;
  translatedText: string;
};

export type VxTwitterTextTranslations = {
  model?: string;
  main?: TranslationDecision;
  quote?: TranslationDecision;
};

type TranslationInput = {
  mainText: string;
  quoteText?: string;
};

type LoggerLike = {
  warn: (obj: unknown, msg?: string) => void;
};

type MinimalTranslationConfig =
  Pick<AppConfig, "DEEPSEEK_API_KEY">
  & Partial<Pick<AppConfig, "AI_REQUEST_TIMEOUT_MS" | "AI_MAX_RETRIES" | "AI_TEMPERATURE" | "DEEPSEEK_MODEL">>
  & Partial<AppConfig>;

type TranslationDeps = {
  config: MinimalTranslationConfig;
  log?: LoggerLike;
  router?: AiProviderRouter;
  guildId?: string;
  chat?: (
    config: AppConfig,
    messages: ChatMessage[],
    third?: AbortSignal | Record<string, unknown>,
  ) => Promise<DeepSeekResult>;
};

function normalizeConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  if (value > 1 && value <= 100) return value / 100;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function boolValue(value: unknown): boolean {
  return value === true;
}

function normalizeTranslationDecision(value: unknown): TranslationDecision | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return {
    shouldTranslate: boolValue(record.shouldTranslate),
    sourceLanguage: stringValue(record.sourceLanguage).toLowerCase(),
    confidence: normalizeConfidence(record.confidence),
    translatedText: stringValue(record.translatedText),
  };
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? trimmed;
}

export function parseDeepSeekJsonResponse(text: string): Record<string, unknown> {
  const raw = stripCodeFence(String(text || ""));
  return JSON.parse(raw) as Record<string, unknown>;
}

function isUnknownLanguage(language: string): boolean {
  return language === "" || language === "und" || language === "unknown";
}

function isJapaneseLanguage(language: string): boolean {
  return language === "ja" || language.startsWith("ja-") || language === "japanese";
}

function isTranslationUseful(originalText: string, translation: TranslationDecision | undefined): translation is TranslationDecision {
  if (!translation) return false;
  if (!translation.shouldTranslate) return false;
  if (isJapaneseLanguage(translation.sourceLanguage) || isUnknownLanguage(translation.sourceLanguage)) return false;
  if (translation.confidence < MIN_CONFIDENCE) return false;
  if (!translation.translatedText) return false;
  const normalizedOriginal = stringValue(originalText).replace(/\s+/g, " ");
  const normalizedTranslated = translation.translatedText.replace(/\s+/g, " ");
  return normalizedOriginal !== normalizedTranslated;
}

function buildMessages(input: TranslationInput): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are a language detection and translation engine for X/Twitter posts.",
        "Analyze the main language, mixed-language content, slang, memes, proper nouns, and short noisy text.",
        "Decide conservatively whether each text needs Japanese translation for a Japanese Discord audience.",
        "Do not rely on simple character-set heuristics alone.",
        "When translation is needed, translate into natural Japanese with no explanations or notes.",
        "Return JSON only.",
        "Schema:",
        '{"main":{"shouldTranslate":boolean,"sourceLanguage":string,"confidence":number,"translatedText":string},"quote":{"shouldTranslate":boolean,"sourceLanguage":string,"confidence":number,"translatedText":string}}',
      ].join(" "),
    },
    {
      role: "user",
      content: JSON.stringify({
        instruction: [
          "Translate only when the text is confidently non-Japanese and the Japanese audience would benefit.",
          "Do not translate Japanese, unknown language, low-confidence text, empty text, or text that is effectively untranslated noise.",
          "English is eligible when confidence is high.",
          "Keep URLs, hashtags, mentions, emoji, memes, and proper nouns natural in Japanese context.",
        ].join(" "),
        mainText: input.mainText,
        quoteText: input.quoteText ?? "",
      }),
    },
  ];
}

export async function translateVxTwitterTexts(
  input: TranslationInput,
  deps: TranslationDeps,
): Promise<VxTwitterTextTranslations> {
  try {
    const messages = buildMessages(input);
    const result = deps.router && deps.guildId
      ? await deps.router.chat(deps.guildId, "vx_translation", messages, {
        thinking: false,
        temperature: 0,
        sanitizeOutput: false,
        timeoutMs: Math.min(deps.config.AI_REQUEST_TIMEOUT_MS ?? 45_000, 15_000),
      })
      : await (deps.chat ?? deepseekChat)(deps.config as AppConfig, messages, {
        thinking: false,
        temperature: 0,
        sanitizeOutput: false,
        timeoutMs: Math.min(deps.config.AI_REQUEST_TIMEOUT_MS ?? 45_000, 15_000),
      });
    const { content } = result;
    const parsed = parseDeepSeekJsonResponse(content);
    const main = normalizeTranslationDecision(parsed.main);
    const quote = normalizeTranslationDecision(parsed.quote);
    const translations = {
      main: isTranslationUseful(input.mainText, main) ? main : undefined,
      quote: isTranslationUseful(input.quoteText ?? "", quote) ? quote : undefined,
    };
    return (translations.main || translations.quote) ? { ...translations, model: result.model } : translations;
  } catch (err) {
    deps.log?.warn({ err: String(err) }, "vxtwitter translation skipped");
    return {};
  }
}

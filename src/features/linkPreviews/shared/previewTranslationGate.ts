import type { AppConfig } from "../../../core/config.js";
import type { AiProviderRouter } from "../../ai/aiProviderRouter.js";
import type { ChatMessage } from "../../ai/chatTypes.js";
import { deepseekChat, type DeepSeekResult } from "../../ai/deepseek.js";
import type { PreviewDocument } from "./previewDocument.js";

export type TranslationDecision = {
  shouldTranslate: boolean;
  sourceLanguage: string;
  confidence: number;
  translatedText: string;
};

export type PreviewDocumentTranslations = {
  model?: string;
  translations: Record<string, TranslationDecision>;
};

type LoggerLike = {
  warn: (obj: unknown, msg?: string) => void;
  info?: (obj: unknown, msg?: string) => void;
};

type MinimalTranslationConfig =
  Pick<AppConfig, "DEEPSEEK_API_KEY">
  & Partial<Pick<AppConfig, "AI_REQUEST_TIMEOUT_MS" | "AI_MAX_RETRIES" | "AI_TEMPERATURE" | "DEEPSEEK_MODEL">>
  & Partial<AppConfig>;

export type PreviewTranslationDeps = {
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTranslationDecision(value: unknown): TranslationDecision | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return {
    shouldTranslate: record.shouldTranslate === true,
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

export function parsePreviewTranslationJsonResponse(text: string): Record<string, unknown> {
  return JSON.parse(stripCodeFence(String(text || ""))) as Record<string, unknown>;
}

function isJapaneseLanguage(language: string): boolean {
  return language === "ja" || language.startsWith("ja-") || language === "japanese";
}

function isTranslationUseful(
  originalText: string,
  translation: TranslationDecision | undefined,
): translation is TranslationDecision {
  if (!translation?.shouldTranslate || isJapaneseLanguage(translation.sourceLanguage) || !translation.translatedText) {
    return false;
  }
  return stringValue(originalText).replace(/\s+/g, " ") !== translation.translatedText.replace(/\s+/g, " ");
}

export function collectPreviewTranslationSegments(document: PreviewDocument): Record<string, string> {
  const segments: Record<string, string> = {};
  for (const block of document.blocks) {
    if (block.type !== "text") continue;
    for (const line of block.lines) {
      for (const part of line.parts) {
        if (part.translationKey !== undefined && !Object.hasOwn(segments, part.translationKey)) {
          segments[part.translationKey] = part.text;
        }
      }
    }
  }
  return segments;
}

function buildMessages(segments: Record<string, string>): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are a language detection and translation engine for link preview text.",
        "Analyze the main language, mixed-language content, slang, memes, proper nouns, and short noisy text.",
        "Decide conservatively whether each text needs Japanese translation for a Japanese Discord audience.",
        "Do not rely on simple character-set heuristics alone.",
        "When translation is needed, translate into natural Japanese with no explanations or notes.",
        "Return JSON only.",
        "Schema:",
        '{"translations":{"translationKey":{"shouldTranslate":boolean,"sourceLanguage":string,"confidence":number,"translatedText":string}}}',
      ].join(" "),
    },
    {
      role: "user",
      content: JSON.stringify({
        instruction: [
          "Translate every non-Japanese text into Japanese, including Korean, English, mixed-language text, and text with uncertain language tags.",
          "Do not translate only text that is Japanese, empty, or effectively untranslated noise.",
          "Keep URLs, hashtags, mentions, emoji, memes, and proper nouns natural in Japanese context.",
        ].join(" "),
        segments,
      }),
    },
  ];
}

export async function translatePreviewDocument(
  document: PreviewDocument,
  deps: PreviewTranslationDeps,
): Promise<PreviewDocumentTranslations> {
  const segments = collectPreviewTranslationSegments(document);
  if (Object.keys(segments).length === 0) return { translations: {} };

  try {
    const result = deps.router && deps.guildId
      ? await deps.router.chat(deps.guildId, "preview_translation", buildMessages(segments), {
        thinking: false,
        temperature: 0,
        sanitizeOutput: false,
        timeoutMs: Math.min(deps.config.AI_REQUEST_TIMEOUT_MS ?? 45_000, 15_000),
      })
      : await (deps.chat ?? deepseekChat)(deps.config as AppConfig, buildMessages(segments), {
        thinking: false,
        temperature: 0,
        sanitizeOutput: false,
        timeoutMs: Math.min(deps.config.AI_REQUEST_TIMEOUT_MS ?? 45_000, 15_000),
      });
    const decisions = asRecord(parsePreviewTranslationJsonResponse(result.content).translations) ?? {};
    const translations = Object.fromEntries(
      Object.entries(segments).flatMap(([key, originalText]) => {
        const decision = normalizeTranslationDecision(decisions[key]);
        return isTranslationUseful(originalText, decision) ? [[key, decision]] : [];
      }),
    );
    if (Object.keys(translations).length === 0) deps.log?.info?.({}, "preview translation skipped");
    return Object.keys(translations).length > 0 ? { model: result.model, translations } : { translations };
  } catch (err) {
    deps.log?.warn({ reason: "request_or_response_error", err: String(err) }, "preview translation skipped");
    return { translations: {} };
  }
}

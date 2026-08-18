import type { PreviewDocument } from "../linkPreviews/shared/previewDocument.js";
import {
  parsePreviewTranslationJsonResponse,
  translatePreviewDocument,
  type PreviewTranslationDeps,
  type TranslationDecision,
} from "../linkPreviews/shared/previewTranslationGate.js";

export type { TranslationDecision };

export type VxTwitterTextTranslations = {
  model?: string;
  main?: TranslationDecision;
  quote?: TranslationDecision;
};

type TranslationInput = {
  mainText: string;
  quoteText?: string;
};

export const parseDeepSeekJsonResponse = parsePreviewTranslationJsonResponse;

export async function translateVxTwitterTexts(
  input: TranslationInput,
  deps: PreviewTranslationDeps,
): Promise<VxTwitterTextTranslations> {
  const document: PreviewDocument = {
    version: 1,
    source: "x",
    url: "https://x.com/i/status/0",
    openLabel: "Xで開く",
    blocks: [{
      type: "text",
      id: "legacy-translation-input",
      lines: [
        { parts: [{ text: input.mainText, translationKey: "main" }] },
        ...(input.quoteText ? [{ parts: [{ text: input.quoteText, translationKey: "quote" }] }] : []),
      ],
    }],
  };
  const bundle = await translatePreviewDocument(document, deps);
  const main = bundle.translations.main;
  const quote = bundle.translations.quote;
  return {
    ...(bundle.model && (main || quote) ? { model: bundle.model } : {}),
    ...(main ? { main } : {}),
    ...(quote ? { quote } : {}),
  };
}

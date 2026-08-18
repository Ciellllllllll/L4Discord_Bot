import type { APIMessageTopLevelComponent } from "discord.js";
import type { PreviewDocument } from "./previewDocument.js";
import {
  translatePreviewDocument,
  type PreviewDocumentTranslations,
  type PreviewTranslationDeps,
} from "./previewTranslationGate.js";
import { buildPreviewComponents, hasUsefulPreviewTranslation } from "./previewRenderer.js";

export type PreviewPipelineState = {
  document: PreviewDocument;
  translations: PreviewDocumentTranslations;
};

export type BuiltTranslatedPreview = {
  components: APIMessageTopLevelComponent[];
  state?: PreviewPipelineState;
};

type InjectedPreviewTranslationDeps = {
  translate: (document: PreviewDocument) => Promise<PreviewDocumentTranslations>;
};

export type PreviewPipelineDeps = PreviewTranslationDeps | InjectedPreviewTranslationDeps;

export async function buildTranslatedPreview(
  document: PreviewDocument,
  deps: PreviewPipelineDeps,
): Promise<BuiltTranslatedPreview> {
  const translations = "translate" in deps
    ? await deps.translate(document)
    : await translatePreviewDocument(document, deps);
  const translated = hasUsefulPreviewTranslation(document, translations);
  return {
    components: buildPreviewComponents(document, translations),
    ...(translated ? { state: { document, translations } } : {}),
  };
}

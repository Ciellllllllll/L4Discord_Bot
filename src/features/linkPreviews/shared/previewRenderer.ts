import {
  ButtonStyle,
  ComponentType,
  type APIActionRowComponent,
  type APIButtonComponent,
  type APIComponentInContainer,
  type APIContainerComponent,
  type APIMediaGalleryComponent,
  type APIMessageTopLevelComponent,
  type APISectionComponent,
  type APITextDisplayComponent,
} from "discord.js";
import type {
  PreviewBlock,
  PreviewDocument,
  PreviewMediaBlock,
  PreviewTextBlock,
  PreviewTextPart,
} from "./previewDocument.js";
import type { PreviewDocumentTranslations, TranslationDecision } from "./previewTranslationGate.js";

export const PREVIEW_SHOW_ORIGINAL_ID = "preview:show-original";
export const PREVIEW_SHOW_TRANSLATION_ID = "preview:show-translation";

const PREVIEW_TEXT_COMPONENT_ID_BASE = 2_140_000_000;
const PREVIEW_ATTRIBUTION_COMPONENT_ID = 2_140_000_100;

export type PreviewDisplayMode = "translation" | "original";

function normalizedText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function usefulDecision(
  original: string,
  decision: TranslationDecision | undefined,
): decision is TranslationDecision {
  return decision?.shouldTranslate === true
    && normalizedText(decision.translatedText).length > 0
    && normalizedText(decision.translatedText) !== normalizedText(original);
}

function translatedPartText(
  part: PreviewTextPart,
  translations: PreviewDocumentTranslations,
  mode: PreviewDisplayMode,
): string {
  if (mode === "original" || part.translationKey === undefined) return part.text;
  const decision = translations.translations[part.translationKey];
  return usefulDecision(part.text, decision) ? decision.translatedText : part.text;
}

function renderPart(
  part: PreviewTextPart,
  translations: PreviewDocumentTranslations,
  mode: PreviewDisplayMode,
): string {
  const text = translatedPartText(part, translations, mode);
  return part.strong ? `**${text}**` : text;
}

function renderTextBlock(
  block: PreviewTextBlock,
  translations: PreviewDocumentTranslations,
  mode: PreviewDisplayMode,
): string {
  return block.lines
    .map((line) => `${line.prefix ?? ""}${line.parts.map((part) => renderPart(part, translations, mode)).join("")}`)
    .join("\n")
    .slice(0, 4_000);
}

function hasUsefulTranslationInBlocks(
  blocks: readonly PreviewBlock[],
  translations: PreviewDocumentTranslations,
): boolean {
  return blocks.some((block) => block.type === "text" && block.lines.some((line) => (
    line.parts.some((part) => (
      part.translationKey !== undefined
      && usefulDecision(part.text, translations.translations[part.translationKey])
    ))
  )));
}

type RenderableBlock = {
  block: PreviewBlock;
  componentId: number;
};

type PreviewLayout = {
  blocks: RenderableBlock[];
  translated: boolean;
  attribution?: APITextDisplayComponent;
};

function preparePreviewLayout(
  document: PreviewDocument,
  translations: PreviewDocumentTranslations,
): PreviewLayout {
  const candidates = document.blocks
    .filter((block) => block.type !== "media" || block.items.length > 0)
    .slice(0, 9);
  const possibleAttribution = buildAttribution(translations.model);
  const needsAttributionSlot = possibleAttribution !== undefined
    && hasUsefulTranslationInBlocks(candidates, translations);
  const selected = needsAttributionSlot ? candidates.slice(0, 8) : candidates;
  const translated = hasUsefulTranslationInBlocks(selected, translations);
  return {
    blocks: selected.map((block, index) => ({
      block,
      componentId: PREVIEW_TEXT_COMPONENT_ID_BASE + index,
    })),
    translated,
    ...(translated && possibleAttribution ? { attribution: possibleAttribution } : {}),
  };
}

export function hasUsefulPreviewTranslation(
  document: PreviewDocument,
  translations: PreviewDocumentTranslations,
): boolean {
  return preparePreviewLayout(document, translations).translated;
}

function buildTextComponent(
  block: PreviewTextBlock,
  translations: PreviewDocumentTranslations,
  mode: PreviewDisplayMode,
  componentId: number,
): APITextDisplayComponent | APISectionComponent {
  const display: APITextDisplayComponent = {
    type: ComponentType.TextDisplay,
    id: componentId,
    content: renderTextBlock(block, translations, mode),
  };
  if (!block.thumbnailUrl) return display;
  return {
    type: ComponentType.Section,
    components: [display],
    accessory: {
      type: ComponentType.Thumbnail,
      media: { url: block.thumbnailUrl },
      ...(block.thumbnailDescription
        ? { description: block.thumbnailDescription.slice(0, 1_024) }
        : {}),
    },
  };
}

function buildMediaComponent(block: PreviewMediaBlock): APIMediaGalleryComponent {
  return {
    type: ComponentType.MediaGallery,
    items: block.items.slice(0, 10).map((item) => ({
      media: { url: item.url },
      ...(item.description ? { description: item.description.slice(0, 1_024) } : {}),
      ...(item.spoiler ? { spoiler: true } : {}),
    })),
  };
}

function buildAttribution(model: string | undefined): APITextDisplayComponent | undefined {
  const name = model?.trim();
  if (!name) return undefined;
  return {
    type: ComponentType.TextDisplay,
    id: PREVIEW_ATTRIBUTION_COMPONENT_ID,
    content: `-# この投稿は ${name.slice(0, 120)} によって翻訳されました。Made by Ciel`,
  };
}

function buildActionRow(
  document: PreviewDocument,
  translated: boolean,
  mode: PreviewDisplayMode,
): APIActionRowComponent<APIButtonComponent> {
  const label = document.openLabel.trim() || (document.source === "x" ? "Xで開く" : "YouTubeで開く");
  const components: APIButtonComponent[] = [{
    type: ComponentType.Button,
    style: ButtonStyle.Link,
    label,
    url: document.url,
  }];
  if (translated) {
    components.push({
      type: ComponentType.Button,
      style: ButtonStyle.Secondary,
      label: mode === "translation" ? "原文を表示" : "翻訳を表示",
      custom_id: mode === "translation" ? PREVIEW_SHOW_ORIGINAL_ID : PREVIEW_SHOW_TRANSLATION_ID,
    });
  }
  return { type: ComponentType.ActionRow, components };
}

function previewTextContents(
  document: PreviewDocument,
  translations: PreviewDocumentTranslations,
  mode: PreviewDisplayMode,
): Map<number, string> {
  const layout = preparePreviewLayout(document, translations);
  return new Map([
    ...layout.blocks.flatMap(({ block, componentId }) => (
      block.type === "text"
        ? [[componentId, renderTextBlock(block, translations, mode)] as const]
        : []
    )),
    ...(layout.attribution
      ? [[PREVIEW_ATTRIBUTION_COMPONENT_ID, layout.attribution.content] as const]
      : []),
  ]);
}

export function buildPreviewComponents(
  document: PreviewDocument,
  translations: PreviewDocumentTranslations,
  mode: PreviewDisplayMode = "translation",
): APIMessageTopLevelComponent[] {
  const layout = preparePreviewLayout(document, translations);
  const children: APIComponentInContainer[] = [
    ...layout.blocks.map(({ block, componentId }) => (
      block.type === "text"
        ? buildTextComponent(block, translations, mode, componentId)
        : buildMediaComponent(block)
    )),
    ...(layout.attribution ? [layout.attribution] : []),
    buildActionRow(document, layout.translated, mode),
  ];
  const container: APIContainerComponent = {
    type: ComponentType.Container,
    components: children,
  };
  return [container];
}

export function patchPreviewTextComponents(
  currentComponents: readonly unknown[],
  document: PreviewDocument,
  translations: PreviewDocumentTranslations,
  mode: PreviewDisplayMode,
): APIMessageTopLevelComponent[] {
  const next = structuredClone(currentComponents) as Array<Record<string, unknown>>;
  const desiredContents = previewTextContents(document, translations, mode);

  const patch = (component: Record<string, unknown>): void => {
    if (component.type === ComponentType.TextDisplay && typeof component.id === "number") {
      const content = desiredContents.get(component.id);
      if (content !== undefined) component.content = content;
    }
    if (
      component.type === ComponentType.Button
      && (component.custom_id === PREVIEW_SHOW_ORIGINAL_ID || component.custom_id === PREVIEW_SHOW_TRANSLATION_ID)
    ) {
      component.custom_id = mode === "translation" ? PREVIEW_SHOW_ORIGINAL_ID : PREVIEW_SHOW_TRANSLATION_ID;
      component.label = mode === "translation" ? "原文を表示" : "翻訳を表示";
    }
    if (Array.isArray(component.components)) {
      for (const child of component.components) {
        if (child && typeof child === "object") patch(child as Record<string, unknown>);
      }
    }
  };

  for (const component of next) patch(component);
  return next as unknown as APIMessageTopLevelComponent[];
}

export function replacePreviewMedia(
  components: readonly unknown[],
  mediaUrl?: string,
  options: { fallback?: boolean; description?: string } = {},
): APIMessageTopLevelComponent[] {
  const next = structuredClone(components) as Array<Record<string, unknown>>;
  const transform = (children: unknown[]): Array<Record<string, unknown>> => children.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const component = value as Record<string, unknown>;
    if (Array.isArray(component.components)) component.components = transform(component.components);
    return [component];
  });
  const containers: Array<Record<string, unknown>> = [];
  const visit = (component: Record<string, unknown>): void => {
    if (!Array.isArray(component.components)) return;
    component.components = transform(component.components).filter((child) => child.type !== ComponentType.MediaGallery);
    if (component.type === ComponentType.Container) containers.push(component);
    for (const child of component.components as Array<Record<string, unknown>>) visit(child);
  };
  for (const component of next) visit(component);
  const container = containers[0];
  if (container && mediaUrl && Array.isArray(container.components)) {
    const children = container.components as Array<Record<string, unknown>>;
    const index = children.findIndex((child) => child.type === ComponentType.ActionRow);
    children.splice(index < 0 ? children.length : index, 0, {
      type: ComponentType.MediaGallery,
      items: [{ media: { url: mediaUrl }, description: options.description ?? "Preview media" }],
    });
  }
  return next as unknown as APIMessageTopLevelComponent[];
}

import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  type APIMessageTopLevelComponent,
  type ButtonInteraction,
} from "discord.js";
import type { CoreDeps } from "../../../core/deps.js";
import type { AiProviderRouter } from "../../../features/ai/aiProviderRouter.js";
import { PREVIEW_SUMMARY_ID } from "../shared/previewRenderer.js";
import { getPreviewSummary, savePreviewSummary } from "../shared/previewSummary.repository.js";
import {
  PreviewSummaryError,
  summarizePreviewContent,
  type PreviewSummaryDecision,
  type PreviewSummaryInput,
} from "../shared/previewSummaryGate.js";
import { loadWebPage } from "./webLinkExpansion.js";
import type { WebPageFetcher } from "./webPageFetcher.js";
import { parseWebUrl } from "./webPreviewSource.js";

/** 同じページの要約を同時に頼まれても、AI への問い合わせは1回にする */
const inFlight = new Map<string, Promise<SummaryOutcome>>();

type SummaryOutcome =
  | { status: "ok"; decision: PreviewSummaryDecision }
  | { status: "fetch_failed" }
  | { status: "summary_failed" };

export type WebSummaryInteractionDeps = {
  fetcher?: WebPageFetcher;
  getSummary?: (url: string) => Promise<PreviewSummaryDecision | null>;
  saveSummary?: (url: string, decision: PreviewSummaryDecision) => Promise<void>;
  summarize?: (input: PreviewSummaryInput) => Promise<PreviewSummaryDecision>;
};

/** カードの開くボタン（先頭のリンクボタン）の URL。要約するページはここから決める */
export function firstLinkButtonUrl(components: readonly unknown[]): string | undefined {
  let found: string | undefined;
  const visit = (value: unknown): void => {
    if (found || !value || typeof value !== "object") return;
    const component = value as {
      type?: unknown; style?: unknown; url?: unknown; components?: readonly unknown[]; toJSON?: () => unknown;
    };
    if (typeof component.toJSON === "function") { visit(component.toJSON()); return; }
    if (component.type === ComponentType.Button && component.style === ButtonStyle.Link && typeof component.url === "string") {
      found = component.url;
      return;
    }
    for (const child of component.components ?? []) visit(child);
  };
  for (const component of components) visit(component);
  return found;
}

function summaryComponents(content: string): APIMessageTopLevelComponent[] {
  return [{
    type: ComponentType.Container,
    components: [{ type: ComponentType.TextDisplay, content: content.slice(0, 4_000) }],
  }];
}

function decisionContent(decision: PreviewSummaryDecision): string {
  if (!decision.shouldSummarize) return "このページには要約できる本文が見つかりませんでした。";
  const model = decision.model?.trim();
  return [
    "### 📝 AI要約",
    decision.summary,
    "",
    `-# ${model ? `この要約は ${model.slice(0, 120)} によって生成されました。` : ""}内容が正確とは限りません。Made by Ciel`,
  ].join("\n");
}

// 要約で使う依存。aiRouter は要約に必須。
type WebSummaryDeps =
  & Pick<CoreDeps, "config" | "db" | "log" | "client">
  & { aiRouter: AiProviderRouter };

async function summarizeUrl(
  url: string,
  ctx: WebSummaryDeps,
  guildId: string,
  deps: WebSummaryInteractionDeps,
): Promise<SummaryOutcome> {
  const cached = await (deps.getSummary ? deps.getSummary(url) : getPreviewSummary(ctx.db, url));
  if (cached) return { status: "ok", decision: cached };
  const loaded = await loadWebPage({ url }, deps.fetcher);
  if (loaded.status === "error") {
    ctx.log.warn({ reason: loaded.reason, url }, "web summary page fetch failed");
    return { status: "fetch_failed" };
  }
  const input: PreviewSummaryInput = {
    url,
    title: loaded.page.title,
    ...(loaded.page.description ? { description: loaded.page.description } : {}),
    ...(loaded.page.siteName ? { siteName: loaded.page.siteName } : {}),
    text: loaded.page.text,
  };
  let decision: PreviewSummaryDecision;
  try {
    decision = deps.summarize
      ? await deps.summarize(input)
      : await summarizePreviewContent(input, { config: ctx.config, log: ctx.log, router: ctx.aiRouter, guildId });
  } catch (error) {
    if (error instanceof PreviewSummaryError) return { status: "summary_failed" };
    throw error;
  }
  try {
    await (deps.saveSummary ? deps.saveSummary(url, decision) : savePreviewSummary(ctx.db, url, decision));
  } catch (error) {
    ctx.log.warn({ err: String(error), url }, "web summary save failed");
  }
  return { status: "ok", decision };
}

function sharedSummary(
  url: string,
  ctx: WebSummaryDeps,
  guildId: string,
  deps: WebSummaryInteractionDeps,
): Promise<SummaryOutcome> {
  const existing = inFlight.get(url);
  if (existing) return existing;
  const current = summarizeUrl(url, ctx, guildId, deps).finally(() => {
    if (inFlight.get(url) === current) inFlight.delete(url);
  });
  inFlight.set(url, current);
  return current;
}

export async function handleWebSummaryInteraction(
  interaction: ButtonInteraction,
  ctx: WebSummaryDeps,
  deps: WebSummaryInteractionDeps = {},
): Promise<boolean> {
  if (interaction.customId !== PREVIEW_SUMMARY_ID) return false;
  const guildId = interaction.guildId;
  if (!guildId || guildId !== ctx.config.GUILD_ID || interaction.message.author.id !== ctx.client.user?.id) return false;

  const linkUrl = firstLinkButtonUrl(interaction.message.components);
  const target = linkUrl ? parseWebUrl(linkUrl) : null;
  if (!target) {
    await interaction.reply({ content: "要約するページが見つかりませんでした。", flags: MessageFlags.Ephemeral })
      .catch(() => undefined);
    return true;
  }
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const outcome = await sharedSummary(target.url, ctx, guildId, deps);
    const content = outcome.status === "ok"
      ? decisionContent(outcome.decision)
      : outcome.status === "fetch_failed"
        ? "ページを取得できなかったため、要約できませんでした。"
        : "AIによる要約に失敗しました。しばらくしてからお試しください。";
    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: summaryComponents(content),
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    ctx.log.warn({ err: String(error), messageId: interaction.message.id }, "web summary failed");
    const content = "要約の表示に失敗しました。しばらくしてからお試しください。";
    if (!interaction.deferred && !interaction.replied) {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
      return true;
    }
    // 保留中の応答を書き換え、読み込み中の表示を残さない。書き換えられなければ別の応答で伝える
    const edited = await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: summaryComponents(content),
      allowedMentions: { parse: [] },
    }).then(() => true, () => false);
    if (!edited) await interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
  }
  return true;
}

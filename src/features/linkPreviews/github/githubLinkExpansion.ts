import type { ExpansionReply } from "../shared/linkExpansionTracker.js";
import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  type APIMessageTopLevelComponent,
  type Message,
  type MessageCreateOptions,
} from "discord.js";
import type { CoreDeps } from "../../../core/deps.js";
import type { AppConfig } from "../../../core/config.js";
import type { AiProviderRouter } from "../../ai/aiProviderRouter.js";
import { buildTranslatedPreview, type PreviewPipelineState } from "../shared/previewPipeline.js";
import { savePreviewTranslationState } from "../shared/previewState.repository.js";
import {
  translatePreviewDocument,
  type PreviewDocumentTranslations,
} from "../shared/previewTranslationGate.js";
import {
  githubPreviewToDocument,
  type GithubReplyTarget,
} from "./githubPreviewSource.js";
import {
  GithubApiClient,
  type GithubApiClientOptions,
  type GithubApiErrorReason,
  type GithubApiResult,
} from "./githubApiClient.js";

type LoggerLike = {
  warn: (obj: unknown, message?: string) => void;
};

export type GithubPreviewPayload = MessageCreateOptions & {
  embeds: [];
  flags: MessageFlags.IsComponentsV2;
  components: APIMessageTopLevelComponent[];
  allowedMentions: { parse: []; repliedUser: false };
  previewState?: PreviewPipelineState;
};

export type GithubPreviewBuildResult =
  | { target: GithubReplyTarget; status: "success"; payload: GithubPreviewPayload }
  | { target: GithubReplyTarget; status: "error"; reason: GithubApiErrorReason; payload: GithubPreviewPayload };

export type GithubPreviewBuildOptions = GithubApiClientOptions & {
  client?: Pick<GithubApiClient, "fetchPreview">;
  imageUrlByCanonicalUrl?: ReadonlyMap<string, string>;
  config?: Pick<AppConfig, "DEEPSEEK_API_KEY"> & Partial<AppConfig>;
  log?: LoggerLike;
  aiRouter?: AiProviderRouter;
  guildId?: string;
  translate?: (document: ReturnType<typeof githubPreviewToDocument>) => Promise<PreviewDocumentTranslations>;
};

/** 再試行で回復しうる失敗。非公開・未検出・権限なし・応答過大は再試行しても変わらない。 */
const TRANSIENT_GITHUB_FAILURES: ReadonlySet<GithubApiErrorReason> = new Set([
  "rate_limited", "timeout", "invalid_json", "request_failed", "api_error",
]);

export function isTransientGithubFailure(reason: GithubApiErrorReason): boolean {
  return TRANSIENT_GITHUB_FAILURES.has(reason);
}

function reasonLabel(reason: GithubApiErrorReason): string {
  switch (reason) {
    case "private_repository": return "非公開リポジトリのため表示できません。";
    case "not_found": return "公開ページが見つかりませんでした。";
    case "forbidden": return "GitHub APIからの取得が許可されませんでした。";
    case "rate_limited": return "GitHub APIの利用上限に達しました。";
    case "timeout": return "GitHub APIの応答がタイムアウトしました。";
    case "response_too_large": return "GitHub APIの応答が大きすぎました。";
    case "invalid_json":
    case "invalid_response": return "GitHub APIの応答を解釈できませんでした。";
    case "request_failed":
    case "api_error": return "GitHub APIから取得できませんでした。";
  }
}

function failureComponents(target: GithubReplyTarget, reason: GithubApiErrorReason): APIMessageTopLevelComponent[] {
  return [{
    type: ComponentType.Container,
    components: [
      {
        type: ComponentType.TextDisplay,
        content: `### GitHubリンクを取得できませんでした\n${reasonLabel(reason)}`,
      },
      {
        type: ComponentType.ActionRow,
        components: [{
          type: ComponentType.Button,
          style: ButtonStyle.Link,
          label: "GitHubで開く",
          url: target.canonicalUrl,
        }],
      },
    ],
  }];
}

export function buildGithubFailurePayload(
  target: GithubReplyTarget,
  reason: GithubApiErrorReason,
): GithubPreviewPayload {
  return {
    embeds: [],
    flags: MessageFlags.IsComponentsV2,
    components: failureComponents(target, reason),
    allowedMentions: { parse: [], repliedUser: false },
  };
}

async function translateDocument(
  document: ReturnType<typeof githubPreviewToDocument>,
  options: GithubPreviewBuildOptions,
): Promise<PreviewDocumentTranslations> {
  try {
    if (options.translate) return await options.translate(document);
    if (!options.config) return { translations: {} };
    return await translatePreviewDocument(document, {
      config: options.config,
      log: options.log,
      router: options.aiRouter,
      guildId: options.guildId,
    });
  } catch (error) {
    options.log?.warn({ error: String(error) }, "github preview translation skipped");
    return { translations: {} };
  }
}

function successPayload(built: Awaited<ReturnType<typeof buildTranslatedPreview>>): GithubPreviewPayload {
  return {
    embeds: [],
    flags: MessageFlags.IsComponentsV2,
    components: built.components,
    allowedMentions: { parse: [], repliedUser: false },
    ...(built.state ? { previewState: built.state } : {}),
  };
}

export async function buildGithubReplyPayloads(
  targets: readonly GithubReplyTarget[],
  options: GithubPreviewBuildOptions = {},
): Promise<GithubPreviewBuildResult[]> {
  const client = options.client ?? new GithubApiClient(options);
  const uniqueTargets = targets.filter((target, index, all) => (
    all.findIndex((candidate) => candidate.canonicalUrl === target.canonicalUrl) === index
  )).slice(0, 5);
  return await Promise.all(uniqueTargets.map(async (target): Promise<GithubPreviewBuildResult> => {
    let result: GithubApiResult;
    try {
      result = await client.fetchPreview(target);
    } catch (error) {
      options.log?.warn({ error: String(error), url: target.canonicalUrl }, "github API preview fetch failed");
      const reason: GithubApiErrorReason = "request_failed";
      return { target, status: "error", reason, payload: buildGithubFailurePayload(target, reason) };
    }
    if (result.status === "error") {
      options.log?.warn({ reason: result.reason, statusCode: result.statusCode, url: target.canonicalUrl }, "github API preview fetch failed");
      return { target, status: "error", reason: result.reason, payload: buildGithubFailurePayload(target, result.reason) };
    }
    try {
      const document = githubPreviewToDocument(result.preview, {
        embedImageUrl: options.imageUrlByCanonicalUrl?.get(target.canonicalUrl),
      });
      const built = await buildTranslatedPreview(document, {
        translate: async () => await translateDocument(document, options),
      });
      return { target, status: "success", payload: successPayload(built) };
    } catch (error) {
      options.log?.warn({ error: String(error), url: target.canonicalUrl }, "github preview document build failed");
      const reason: GithubApiErrorReason = "request_failed";
      return { target, status: "error", reason, payload: buildGithubFailurePayload(target, reason) };
    }
  }));
}

export type SendGithubExpansionDeps = {
  replyExpansion?: ExpansionReply;
  db: CoreDeps["db"];
  config: AppConfig;
  log: LoggerLike;
  aiRouter?: AiProviderRouter;
  buildReplyPayloads?: typeof buildGithubReplyPayloads;
  saveState?: typeof savePreviewTranslationState;
};

export async function sendGithubLinkExpansion(
  message: Message,
  results: readonly GithubPreviewBuildResult[],
  deps: SendGithubExpansionDeps,
  options: { includeFailures?: boolean } = {},
): Promise<void> {
  for (const [index, result] of results.entries()) {
    if (result.status === "error" && options.includeFailures !== true) continue;
    try {
      const previewState = result.status === "success" ? result.payload.previewState : undefined;
      const { previewState: _previewState, ...replyPayload } = result.payload;
      const retry = result.status === "error" && isTransientGithubFailure(result.reason);
      const reply = await (deps.replyExpansion?.(
        message, `github:${index}`, replyPayload, undefined, { retry },
      ) ?? message.reply(replyPayload));
      if (!previewState || !message.guildId) continue;
      try {
        await (deps.saveState ?? savePreviewTranslationState)(deps.db, {
          version: 1,
          messageId: reply.id,
          guildId: message.guildId,
          channelId: message.channelId,
          sourceUrl: previewState.document.url,
          ...previewState,
        });
      } catch (error) {
        deps.log.warn({ error: String(error), messageId: reply.id }, "github preview state save failed");
      }
    } catch (error) {
      deps.log.warn({ error: String(error) }, "github preview reply error");
    }
  }
}

import assert from "node:assert/strict";
import { ComponentType, MessageFlags } from "discord.js";
import {
  buildGithubFailurePayload,
  buildGithubReplyPayloads,
  sendGithubLinkExpansion,
} from "./githubLinkExpansion.js";
import { parseGithubUrl } from "./githubPreviewSource.js";

const target = parseGithubUrl("https://github.com/octo/hello/issues/42")!;

function allText(value: unknown): string {
  return JSON.stringify(value);
}

{
  let calls = 0;
  const result = await buildGithubReplyPayloads([target], {
    imageUrlByCanonicalUrl: new Map([[target.canonicalUrl, "https://opengraph.githubassets.com/abc/octo/hello"]]),
    client: {
      fetchPreview: async () => {
        calls += 1;
        return {
          status: "ok" as const,
          preview: {
            kind: "issue" as const,
            canonicalUrl: target.canonicalUrl,
            owner: "octo",
            repository: "hello",
            title: "Fix the widget",
            description: "The widget is broken.",
            author: { name: "contributor" },
            number: 42,
            state: "open",
            labels: ["bug"],
          },
        };
      },
    },
    translate: async () => ({
      model: "test-model",
      translations: {
        body: {
          shouldTranslate: true,
          sourceLanguage: "en",
          confidence: 1,
          translatedText: "ウィジェットが壊れています。",
        },
      },
    }),
  });
  assert.equal(calls, 1);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.status, "success");
  if (result[0]?.status === "success") {
    assert.equal(result[0].payload.flags, MessageFlags.IsComponentsV2);
    assert.deepEqual(result[0].payload.embeds, []);
    assert.equal("content" in result[0].payload, false);
    assert.equal(allText(result[0].payload).includes("ウィジェットが壊れています。"), true);
    assert.equal(allText(result[0].payload).includes('translationKey":"title'), false);
    assert.equal(result[0].payload.previewState?.document.source, "github");
    assert.equal(allText(result[0].payload).includes("https://opengraph.githubassets.com/abc/octo/hello"), true);
    assert.equal(result[0].payload.previewState?.document.blocks.some((block) => block.type === "media"), true);
  }
}

{
  const result = await buildGithubReplyPayloads([target], {
    client: {
      fetchPreview: async () => ({ status: "error" as const, reason: "private_repository" as const }),
    },
  });
  assert.equal(result[0]?.status, "error");
  if (result[0]?.status === "error") {
    assert.equal(result[0].reason, "private_repository");
    assert.equal(result[0].payload.flags, MessageFlags.IsComponentsV2);
    assert.deepEqual(result[0].payload.embeds, []);
    assert.equal(allText(result[0].payload).includes("非公開"), true);
  }
}

{
  const payload = buildGithubFailurePayload(target, "rate_limited");
  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(payload.embeds, []);
  assert.equal((payload.components[0] as { type?: number }).type, ComponentType.Container);
  assert.equal(allText(payload).includes("GitHubで開く"), true);
}

{
  const replies: unknown[] = [];
  const saved: unknown[] = [];
  await sendGithubLinkExpansion({
    guildId: "guild-1",
    channelId: "channel-1",
    reply: async (payload: unknown) => {
      replies.push(payload);
      return { id: "reply-1" };
    },
  } as never, [
    {
      target,
      status: "success",
      payload: buildGithubFailurePayload(target, "api_error"),
    },
  ], {
    db: {} as never,
    config: {} as never,
    log: { warn: () => {} },
    saveState: async (_db, state) => { saved.push(state); },
  });
  assert.equal(replies.length, 1);
  assert.equal(saved.length, 0);
}

{
  const replies: unknown[] = [];
  const saved: unknown[] = [];
  const previewState = {
    document: {
      version: 1 as const,
      source: "github" as const,
      url: target.canonicalUrl,
      openLabel: "GitHubで開く",
      blocks: [],
    },
    translations: {
      translations: {
        body: {
          shouldTranslate: true,
          sourceLanguage: "en",
          confidence: 1,
          translatedText: "本文",
        },
      },
    },
  };
  await sendGithubLinkExpansion({
    id: "source-message",
    guildId: "guild-1",
    channelId: "channel-1",
    reply: async (payload: unknown) => {
      replies.push(payload);
      return { id: "reply-2" };
    },
  } as never, [{
    target,
    status: "success",
    payload: {
      embeds: [],
      flags: MessageFlags.IsComponentsV2,
      components: [],
      allowedMentions: { parse: [], repliedUser: false },
      previewState,
    },
  }], {
    db: {} as never,
    config: {} as never,
    log: { warn: () => {} },
    saveState: async (_db, state) => { saved.push(state); },
  });
  assert.equal("previewState" in (replies[0] as object), false);
  assert.equal(saved.length, 1);
  assert.equal((saved[0] as { messageId?: string }).messageId, "reply-2");
  assert.equal((saved[0] as { document?: { source?: string } }).document?.source, "github");
}

console.log("githubLinkExpansion.spec.ts: all assertions passed");

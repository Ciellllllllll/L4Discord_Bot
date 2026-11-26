import assert from "node:assert/strict";
import { test } from "node:test";
import { MessageFlags } from "discord.js";
import { AiRequestError } from "./aiRequestError.js";
import { handleQCommand } from "./aiSlashCommands.js";
import { QAttachmentError } from "./qAttachment.js";

function makeMockCtx() {
  return {
    log: { error: () => undefined, warn: () => undefined },
  };
}

function makeMockInteraction(
  userId: string,
  overrides: {
    deferReply?: () => Promise<void>;
    editReply?: () => Promise<void>;
    deferred?: boolean;
    replied?: boolean;
  } = {},
) {
  const replies: Array<{ content: string; flags?: unknown }> = [];
  const editReplies: Array<{ content?: string }> = [];
  const followUps: Array<{ content: string; flags?: unknown }> = [];
  const interaction = {
    guildId: "guild-1",
    user: { id: userId, username: "tester" },
    deferred: overrides.deferred ?? false,
    replied: overrides.replied ?? false,
    options: {
      getString: () => "hello",
      getAttachment: () => null,
    },
    reply: async (opts: { content: string; flags?: unknown }) => {
      interaction.replied = true;
      replies.push(opts);
    },
    deferReply: async () => {
      if (overrides.deferReply) {
        await overrides.deferReply();
      }
      interaction.deferred = true;
    },
    editReply: async (opts: { content?: string }) => {
      if (overrides.editReply) {
        await overrides.editReply();
      }
      editReplies.push(opts);
    },
    followUp: async (opts: { content: string; flags?: unknown }) => {
      followUps.push(opts);
    },
  };
  return { interaction, replies, editReplies, followUps };
}

test("handleQCommand blocks concurrent calls and consumes cooldown on success", async () => {
  const userId = `q-cooldown-success-${Date.now()}`;
  let releaseRoute!: () => void;
  const routeGate = new Promise<void>((resolve) => {
    releaseRoute = resolve;
  });

  const first = makeMockInteraction(userId);
  const second = makeMockInteraction(userId);
  const third = makeMockInteraction(userId);
  const ctx = makeMockCtx();

  const firstPromise = handleQCommand(first.interaction as never, ctx as never, {
    getAiR18Enabled: async () => false,
    createQueryService: () => ({
      routeSlashInteraction: async () => {
        await routeGate;
      },
    }),
  });

  await new Promise((resolve) => setImmediate(resolve));

  // Concurrent second call must be rejected immediately
  await handleQCommand(second.interaction as never, ctx as never, {
    getAiR18Enabled: async () => false,
    createQueryService: () => ({ routeSlashInteraction: async () => undefined }),
  });
  assert.equal(second.replies.length, 1);
  assert.match(second.replies[0]!.content, /少し待ってから/);

  // Complete first call successfully
  releaseRoute();
  await firstPromise;

  // Immediate retry after success must be blocked by cooldown
  await handleQCommand(third.interaction as never, ctx as never, {
    getAiR18Enabled: async () => false,
    createQueryService: () => ({ routeSlashInteraction: async () => undefined }),
  });
  assert.equal(third.replies.length, 1);
  assert.match(third.replies[0]!.content, /少し待ってから/);
});

test("handleQCommand does not consume cooldown on QAttachmentError or configuration error", async () => {
  const userId = `q-no-cooldown-${Date.now()}`;
  const ctx = makeMockCtx();

  const attachErr = makeMockInteraction(userId);
  await handleQCommand(attachErr.interaction as never, ctx as never, {
    getAiR18Enabled: async () => false,
    createQueryService: () => ({
      routeSlashInteraction: async () => {
        throw new QAttachmentError("添付ファイルが大きすぎます");
      },
    }),
  });
  assert.equal(attachErr.editReplies[0]?.content, "添付ファイルが大きすぎます");

  // Immediate retry after QAttachmentError must not be rate-limited
  const configErr = makeMockInteraction(userId);
  await handleQCommand(configErr.interaction as never, ctx as never, {
    getAiR18Enabled: async () => false,
    createQueryService: () => ({
      routeSlashInteraction: async () => {
        throw new AiRequestError("configuration", "missing api key");
      },
    }),
  });
  assert.equal(configErr.replies.length, 0);
  assert.match(configErr.editReplies[0]?.content ?? "", /設定が未完了/);

  // Immediate retry after configuration error must still be allowed
  let providerCalled = 0;
  const providerErr = makeMockInteraction(userId);
  await handleQCommand(providerErr.interaction as never, ctx as never, {
    getAiR18Enabled: async () => false,
    createQueryService: () => ({
      routeSlashInteraction: async () => {
        providerCalled += 1;
        throw new AiRequestError("timeout", "upstream timeout");
      },
    }),
  });
  assert.equal(providerCalled, 1);
  assert.match(providerErr.editReplies[0]?.content ?? "", /AI への問い合わせに失敗/);

  // Immediate retry after provider failure MUST be blocked by cooldown
  const blocked = makeMockInteraction(userId);
  await handleQCommand(blocked.interaction as never, ctx as never, {
    getAiR18Enabled: async () => false,
    createQueryService: () => ({ routeSlashInteraction: async () => undefined }),
  });
  assert.equal(blocked.replies.length, 1);
  assert.match(blocked.replies[0]!.content, /少し待ってから/);
});

test("handleQCommand replies with ephemeral failure message when setup throws before deferReply", async () => {
  const userId = `q-setup-error-${Date.now()}`;
  const ctx = makeMockCtx();

  const r18Fail = makeMockInteraction(userId);
  await handleQCommand(r18Fail.interaction as never, ctx as never, {
    getAiR18Enabled: async () => {
      throw new Error("db down");
    },
    createQueryService: () => ({ routeSlashInteraction: async () => undefined }),
  });
  assert.equal(r18Fail.replies.length, 1);
  assert.equal(r18Fail.replies[0]!.flags, MessageFlags.Ephemeral);
  assert.match(r18Fail.replies[0]!.content, /AI への問い合わせに失敗/);

  // Setup failure before AI call should not consume cooldown
  const deferredFail = makeMockInteraction(userId, {
    deferred: true,
    deferReply: async () => {
      throw new Error("already deferred");
    },
  });
  await handleQCommand(deferredFail.interaction as never, ctx as never, {
    getAiR18Enabled: async () => false,
    createQueryService: () => ({ routeSlashInteraction: async () => undefined }),
  });
  assert.equal(deferredFail.replies.length, 0);
  assert.equal(deferredFail.editReplies.length, 1);
  assert.match(deferredFail.editReplies[0]!.content ?? "", /AI への問い合わせに失敗/);

  const repliedFail = makeMockInteraction(userId, {
    replied: true,
    deferReply: async () => {
      throw new Error("already replied");
    },
  });
  await handleQCommand(repliedFail.interaction as never, ctx as never, {
    getAiR18Enabled: async () => false,
    createQueryService: () => ({ routeSlashInteraction: async () => undefined }),
  });
  assert.equal(repliedFail.followUps.length, 1);
  assert.equal(repliedFail.followUps[0]!.flags, MessageFlags.Ephemeral);
  assert.match(repliedFail.followUps[0]!.content, /AI への問い合わせに失敗/);
});

test("handleQCommand swallows and logs failure when editReply throws on main error path", async () => {
  const userId = `q-edit-reply-fail-${Date.now()}`;
  const errors: unknown[][] = [];
  const warns: unknown[][] = [];
  const ctx = {
    log: {
      error: (...args: unknown[]) => { errors.push(args); },
      warn: (...args: unknown[]) => { warns.push(args); },
    },
  };

  const expired = makeMockInteraction(userId, {
    editReply: async () => {
      throw Object.assign(new Error("Unknown Webhook"), { code: 10_015, status: 404 });
    },
  });

  await assert.doesNotReject(async () => {
    await handleQCommand(expired.interaction as never, ctx as never, {
      getAiR18Enabled: async () => false,
      createQueryService: () => ({
        routeSlashInteraction: async () => {
          throw new AiRequestError("configuration", "missing api key");
        },
      }),
    });
  });

  assert.equal(errors.length, 1);
  assert.equal(warns.length, 1);

  // inFlightQUsers must be released so next call is not blocked
  let secondCalled = false;
  const retry = makeMockInteraction(userId);
  await handleQCommand(retry.interaction as never, ctx as never, {
    getAiR18Enabled: async () => false,
    createQueryService: () => ({
      routeSlashInteraction: async () => {
        secondCalled = true;
      },
    }),
  });
  assert.equal(secondCalled, true);
});

test("handleQCommand does not overwrite sent answer via editReply when an error occurs after editReply succeeds", async () => {
  const userId = `q-post-reply-error-${Date.now()}`;
  const ctx = makeMockCtx();
  const mock = makeMockInteraction(userId);

  await handleQCommand(mock.interaction as never, ctx as never, {
    getAiR18Enabled: async () => false,
    createQueryService: () => ({
      routeSlashInteraction: async (interaction) => {
        await interaction.editReply({ content: "回答本文" });
        throw new Error("post-reply unexpected error");
      },
    }),
  });

  assert.equal(mock.editReplies.length, 1);
  assert.equal(mock.editReplies[0]?.content, "回答本文");
  assert.equal(mock.followUps.length, 1);
  assert.equal(mock.followUps[0]?.flags, MessageFlags.Ephemeral);
  assert.match(mock.followUps[0]?.content ?? "", /AI への問い合わせに失敗/);
});

test("handleQCommand overwrites progress editReply via editReply when an error occurs before final answer", async () => {
  const userId = `q-progress-reply-error-${Date.now()}`;
  const ctx = makeMockCtx();
  const mock = makeMockInteraction(userId);

  await handleQCommand(mock.interaction as never, ctx as never, {
    getAiR18Enabled: async () => true,
    createQueryService: () => ({
      routeSlashInteraction: async (_interaction, options) => {
        await options?.editProgressReply?.({ content: "生成中です。" });
        throw new Error("local llm failed");
      },
    }),
  });

  assert.equal(mock.editReplies.length, 2);
  assert.equal(mock.editReplies[0]?.content, "生成中です。");
  assert.match(mock.editReplies[1]?.content ?? "", /AI への問い合わせに失敗/);
  assert.equal(mock.followUps.length, 0);
});

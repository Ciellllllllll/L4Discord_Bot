import assert from "node:assert/strict";
import { KeywordResponder } from "./keywordResponder.js";

const TRIGGER_URL = "https://media.example.com/trigger.gif";
const RESPONSE_URL = "https://media.example.com/response.gif";

function createCtx(settingsData: Record<string, unknown> = {
  gif_auto_reply: { trigger_url: TRIGGER_URL, response_url: RESPONSE_URL },
}): {
  ctx: unknown;
  warnings: unknown[];
} {
  const query = {
    selectAll() { return this; },
    where() { return this; },
    async executeTakeFirst() {
      return { data: settingsData };
    },
  };
  const warnings: unknown[] = [];
  return {
    ctx: {
      config: {
        GUILD_ID: "guild",
      },
      db: { selectFrom: () => query },
      log: { warn: (entry: unknown) => warnings.push(entry) },
    },
    warnings,
  };
}

function createMessage(input: {
  content?: string;
  attachments?: Array<{ url: string; proxyURL?: string }>;
  embeds?: Array<{ type: string; url: string }>;
  bot?: boolean;
  channelId?: string;
  guildId?: string;
} = {}): { message: unknown; replies: unknown[] } {
  const replies: unknown[] = [];
  const attachments = input.attachments ?? [];
  return {
    message: {
      author: { bot: input.bot ?? false },
      guild: { id: input.guildId ?? "guild" },
      channelId: input.channelId ?? "general",
      content: input.content ?? "",
      attachments: {
        some: (predicate: (attachment: { url: string; proxyURL?: string }) => boolean) => attachments.some(predicate),
      },
      embeds: (input.embeds ?? []).map((embed) => ({ data: { type: embed.type }, url: embed.url })),
      reply: async (payload: unknown) => { replies.push(payload); },
    },
    replies,
  };
}

async function run(): Promise<void> {
  const { ctx } = createCtx();
  const responder = new KeywordResponder(ctx as never);

  const contentMatch = createMessage({ content: `これを見て ${TRIGGER_URL}` });
  await responder.onMessage(contentMatch.message as never);
  assert.deepEqual(contentMatch.replies, [{
    content: RESPONSE_URL,
    allowedMentions: { parse: [], repliedUser: false },
  }]);

  const substringOnly = createMessage({ content: `${TRIGGER_URL}-different` });
  await responder.onMessage(substringOnly.message as never);
  assert.equal(substringOnly.replies.length, 0);

  const prefixedSubstring = createMessage({ content: `x${TRIGGER_URL}` });
  await responder.onMessage(prefixedSubstring.message as never);
  assert.equal(prefixedSubstring.replies.length, 0);

  const wrappedMatch = createMessage({ content: `<${TRIGGER_URL}>` });
  await responder.onMessage(wrappedMatch.message as never);
  assert.equal((wrappedMatch.replies[0] as { content?: string }).content, RESPONSE_URL);

  const attachmentMatch = createMessage({ attachments: [{ url: TRIGGER_URL }] });
  await responder.onMessage(attachmentMatch.message as never);
  assert.equal((attachmentMatch.replies[0] as { content?: string }).content, RESPONSE_URL);

  const proxyAttachmentMatch = createMessage({
    attachments: [{ url: "https://media.example.com/original.gif", proxyURL: TRIGGER_URL }],
  });
  await responder.onMessage(proxyAttachmentMatch.message as never);
  assert.equal((proxyAttachmentMatch.replies[0] as { content?: string }).content, RESPONSE_URL);

  const gifvEmbedMatch = createMessage({ embeds: [{ type: "gifv", url: TRIGGER_URL }] });
  await responder.onMessage(gifvEmbedMatch.message as never);
  assert.deepEqual(gifvEmbedMatch.replies, [{
    content: RESPONSE_URL,
    allowedMentions: { parse: [], repliedUser: false },
  }]);

  const botMessage = createMessage({ content: TRIGGER_URL, bot: true });
  await responder.onMessage(botMessage.message as never);
  assert.equal(botMessage.replies.length, 0);

  const prefixCommand = createMessage({ content: `!command ${TRIGGER_URL}` });
  await responder.onMessage(prefixCommand.message as never);
  assert.equal(prefixCommand.replies.length, 0);

  const otherGuild = createMessage({ content: TRIGGER_URL, guildId: "other-guild" });
  await responder.onMessage(otherGuild.message as never);
  assert.equal(otherGuild.replies.length, 0);

  const excludedCtx = createCtx({ auto_reply_excluded_channel_ids: ["excluded"] }).ctx;
  const excludedMessage = createMessage({ content: TRIGGER_URL, channelId: "excluded" });
  await new KeywordResponder(excludedCtx as never).onMessage(excludedMessage.message as never);
  assert.equal(excludedMessage.replies.length, 0);

  const disabledCtx = createCtx({}).ctx;
  const disabledMessage = createMessage({ content: TRIGGER_URL });
  await new KeywordResponder(disabledCtx as never).onMessage(disabledMessage.message as never);
  assert.equal(disabledMessage.replies.length, 0);

  const malformedCtx = createCtx({
    gif_auto_reply: { trigger_url: TRIGGER_URL, response_url: `https://example.com/${"x".repeat(901)}` },
  }).ctx;
  const malformedMessage = createMessage({ content: TRIGGER_URL });
  await new KeywordResponder(malformedCtx as never).onMessage(malformedMessage.message as never);
  assert.equal(malformedMessage.replies.length, 0);

  const keywordMessage = createMessage({ content: "ばっちぃ" });
  await responder.onMessage(keywordMessage.message as never);
  assert.equal((keywordMessage.replies[0] as { content?: string }).content, "ぱっちぃ君だよ！！！！");
}

run()
  .then(() => console.log("keywordResponder.spec.ts: all assertions passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

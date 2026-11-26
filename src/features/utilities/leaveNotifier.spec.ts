import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ButtonStyle, ChannelType, Collection, ComponentType, MessageFlags, PermissionFlagsBits,
  type APIEmbed, type APIMessageComponent, type APIMessageTopLevelComponent, type Message,
} from "discord.js";
import type { CoreDeps } from "../../core/deps.js";
import { buildMessageLinkExpansionPayload, LeaveNotifierMessageHandler } from "./leaveNotifier.js";
import { CyclicQuoteError, type ExpansionReply } from "../linkPreviews/shared/linkExpansionTracker.js";

function makeMessage(input: {
  content?: string;
  embeds?: APIEmbed[];
  components?: APIMessageTopLevelComponent[];
  attachments?: Array<{ url: string; name: string; contentType: string }>;
} = {}): Message {
  return {
    id: "400",
    channelId: "200",
    content: input.content ?? "",
    url: "https://discord.com/channels/100/200/400",
    createdAt: new Date("2026-06-10T00:00:00.000Z"),
    member: { displayName: "Bot Name" },
    author: {
      bot: true,
      username: "bot-user",
      displayAvatarURL: () => "https://cdn.example.com/avatar.png",
    },
    embeds: (input.embeds ?? []).map((embed) => ({ toJSON: () => embed })),
    components: (input.components ?? []).map((component) => ({ toJSON: () => component })),
    attachments: new Collection((input.attachments ?? []).map((attachment, index) => [
      String(index), { id: String(index), ...attachment },
    ])),
  } as unknown as Message;
}

function handlerFixture(options: {
  postingGuildId?: string;
  linkedChannelId?: string;
  actualGuildId?: string;
  botJoined?: boolean;
  sourceMemberExists?: boolean;
  readerAllowed?: boolean;
  botAllowed?: boolean;
  excluded?: boolean;
  privateThread?: boolean;
  threadMemberExists?: boolean;
  fetchFails?: boolean;
  content?: string;
  authorId?: string;
  authorBot?: boolean;
  replyExpansion?: ExpansionReply;
  lookupError?: { stage: "channel" | "member" | "threadMember" | "botMember" | "message"; code: number };
} = {}) {
  const fail = (stage: NonNullable<typeof options.lookupError>["stage"]) => {
    if (options.lookupError?.stage === stage) throw Object.assign(new Error("lookup failed"), { code: options.lookupError.code });
  };
  const sent: unknown[] = [];
  const warnings: unknown[] = [];
  const fetchedMembers: string[] = [];
  let messageFetches = 0;
  let settingsQueries = 0;
  const reader = { id: "reader", guild: { id: "100" } };
  const bot = { id: "bot" };
  const guild = {
    id: "100",
    members: {
      me: options.lookupError?.stage === "botMember" ? undefined : bot,
      fetchMe: async () => { fail("botMember"); return bot; },
      fetch: async (id: string) => {
        fail("member");
        fetchedMembers.push(id);
        return options.sourceMemberExists === false ? null : id === bot.id ? bot : reader;
      },
    },
  };
  const source = {
    guildId: options.actualGuildId ?? "100",
    guild,
    name: "source",
    type: options.privateThread ? ChannelType.PrivateThread : ChannelType.GuildText,
    isTextBased: () => true,
    isDMBased: () => false,
    permissionsFor: (member: unknown) => {
      assert.ok(member === reader || member === bot, "use members from the source guild");
      return {
        has: (permissions: unknown) => {
          if (permissions === PermissionFlagsBits.ManageThreads) return false;
          assert.deepEqual(permissions, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]);
          return member === reader ? options.readerAllowed !== false : options.botAllowed !== false;
        },
      };
    },
    members: { fetch: async () => { fail("threadMember"); return options.threadMemberExists === false ? null : { id: "reader" }; } },
    messages: {
      fetch: async () => {
        messageFetches++;
        fail("message");
        if (options.fetchFails) throw new Error("Unknown Message");
        return makeMessage({ content: "引用本文" });
      },
    },
  };
  const query = {
    selectAll() { return this; },
    where() { return this; },
    executeTakeFirst: async () => {
      settingsQueries++;
      return { data: { auto_reply_excluded_channel_ids: options.excluded ? ["200"] : [] } };
    },
  };
  const ctx = {
    config: { GUILD_ID: "100" },
    db: { selectFrom: () => query },
    client: {
      user: bot,
      guilds: { cache: new Map(options.botJoined === false ? [] : [["100", guild]]) },
      channels: { fetch: async () => { fail("channel"); return source; } },
    },
    log: { warn: (entry: unknown) => warnings.push(entry) },
  } as unknown as Pick<CoreDeps, "config" | "db" | "log" | "client">;
  const message = {
    author: { id: options.authorId ?? "reader", bot: options.authorBot ?? false },
    member: { id: "reader", guild: { id: options.postingGuildId ?? "100" } },
    guild: { id: options.postingGuildId ?? "100" },
    guildId: options.postingGuildId ?? "100",
    channelId: "200",
    content: options.content ?? `https://discord.com/channels/100/${options.linkedChannelId ?? "200"}/400`,
    channel: {
      isTextBased: () => true,
      isDMBased: () => false,
      send: async (payload: unknown) => { sent.push(payload); },
    },
  } as unknown as Message;
  return {
    handler: new LeaveNotifierMessageHandler(ctx, options.replyExpansion), message, sent, warnings, fetchedMembers,
    messageFetches: () => messageFetches, settingsQueries: () => settingsQueries,
  };
}

for (const stage of ["channel", "member", "threadMember", "botMember", "message"] as const) {
  void test(`propagates temporary ${stage} lookup errors so tracked quotes can be retried`, async () => {
    for (const code of [503, 50001, 50013]) {
      const fixture = handlerFixture({
        privateThread: true, lookupError: { stage, code },
        replyExpansion: async () => { throw new Error("must not send"); },
      });
      await assert.rejects(fixture.handler.onMessage(fixture.message), /lookup failed/);
      assert.equal(fixture.sent.length, 0);
    }
  });
}

for (const [stage, code] of [["channel", 10003], ["member", 10007], ["threadMember", 10007], ["message", 10008]] as const) {
  void test(`ignores definitively missing ${stage} resources`, async () => {
    const fixture = handlerFixture({
      privateThread: true, lookupError: { stage, code },
      replyExpansion: async () => { throw new Error("must not send"); },
    });
    await fixture.handler.onMessage(fixture.message);
    assert.equal(fixture.sent.length, 0);
  });
}

void test("a rejected cyclic quote does not turn into a retryable lookup failure", async () => {
  const fixture = handlerFixture({ replyExpansion: async () => { throw new CyclicQuoteError("cyclic quote"); } });
  await fixture.handler.onMessage(fixture.message);
  assert.equal(fixture.warnings.length, 1);
  assert.equal(fixture.sent.length, 0);
});

void test("registers a quoted message through the shared tracker after checking human permissions", async () => {
  const calls: Array<{ message: Message; key: string; quoted?: Message }> = [];
  const fixture = handlerFixture({
    postingGuildId: "999",
    replyExpansion: async (message, key, _payload, quoted) => {
      calls.push({ message, key, quoted });
      return {} as Message;
    },
  });
  assert.equal(fixture.handler.hasLinks(fixture.message), true);
  await fixture.handler.onMessage(fixture.message);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.message, fixture.message);
  assert.equal(calls[0]?.key, "discord:0");
  assert.equal(calls[0]?.quoted?.id, "400");
  assert.equal(calls[0]?.quoted?.channelId, "200");
  assert.equal(calls[0]?.quoted?.author.bot, true);
  assert.deepEqual(fixture.fetchedMembers, ["reader"]);
  assert.equal(fixture.sent.length, 0, "must not bypass tracking with a direct send");
});

for (const authorId of ["bot", "other-bot"]) {
  void test(`does not expand bot-authored links using bot permissions: ${authorId}`, async () => {
    const fixture = handlerFixture({ authorId, authorBot: true, readerAllowed: false, botAllowed: true });
    await fixture.handler.onMessage(fixture.message);
    assert.equal(fixture.sent.length, 0);
    assert.equal(fixture.settingsQueries(), 0);
    assert.deepEqual(fixture.fetchedMembers, []);
    assert.equal(fixture.messageFetches(), 0);
  });
}

for (const content of ["普通の会話です", "", "https://example.com/article"]) {
  void test(`does not query settings when there is no Discord message link: ${JSON.stringify(content)}`, async () => {
    const fixture = handlerFixture({ postingGuildId: "999", content });
    await fixture.handler.onMessage(fixture.message);
    assert.equal(fixture.settingsQueries(), 0);
    assert.equal(fixture.messageFetches(), 0);
    assert.equal(fixture.sent.length, 0);
  });
}

for (const [name, options] of [
  ["same channel", {}],
  ["different channel", { linkedChannelId: "300" }],
  ["different server", { postingGuildId: "999", linkedChannelId: "300" }],
] as const) {
  void test(`quotes a message from ${name}`, async () => {
    const fixture = handlerFixture(options);
    await fixture.handler.onMessage(fixture.message);
    assert.equal(fixture.sent.length, 1);
    assert.equal(fixture.settingsQueries(), 1);
    assert.equal(fixture.messageFetches(), 1);
    assert.ok(fixture.fetchedMembers.includes("reader"));
    const payload = fixture.sent[0] as { flags: number; allowedMentions: unknown };
    assert.equal(payload.flags, MessageFlags.IsComponentsV2);
    assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false });
    assert.equal(fixture.warnings.length, 0);
  });
}

for (const [name, options] of [
  ["bot has not joined", { botJoined: false }],
  ["link server does not match channel", { actualGuildId: "999" }],
  ["reader is not a source member", { sourceMemberExists: false }],
  ["reader cannot read history", { readerAllowed: false }],
  ["bot cannot read history", { botAllowed: false }],
  ["reader has not joined a private thread", { privateThread: true, threadMemberExists: false }],
  ["posting channel is excluded", { excluded: true }],
  ["prefix command", { content: "!echo https://discord.com/channels/100/200/400" }],
] as const) {
  void test(`does not quote when ${name}`, async () => {
    const fixture = handlerFixture(options);
    await fixture.handler.onMessage(fixture.message);
    assert.equal(fixture.sent.length, 0);
    assert.equal(fixture.messageFetches(), 0);
    assert.equal(fixture.warnings.length, 0);
  });
}

void test("quotes an accessible private thread", async () => {
  const fixture = handlerFixture({ privateThread: true });
  await fixture.handler.onMessage(fixture.message);
  assert.equal(fixture.sent.length, 1);
});

void test("logs fetch errors without sending a partial quote", async () => {
  const fixture = handlerFixture({ fetchFails: true });
  await fixture.handler.onMessage(fixture.message);
  assert.equal(fixture.sent.length, 0);
  assert.equal(fixture.warnings.length, 1);
});

void test("retains legacy embeds and does not re-upload attachments", () => {
  const payload = buildMessageLinkExpansionPayload(makeMessage({
    content: "本文あり",
    embeds: [{
      title: "通知タイトル", description: "通知本文", color: 0xff0000,
      image: { url: "https://cdn.example.com/image.png" },
      fields: [{ name: "項目", value: "値", inline: true }],
    }],
    attachments: [{ url: "https://cdn.example.com/report.pdf", name: "report.pdf", contentType: "application/pdf" }],
  }), "general");
  const json = JSON.stringify(payload);
  for (const text of ["本文あり", "通知タイトル", "通知本文", "項目", "値", "https://cdn.example.com/image.png"]) {
    assert.ok(json.includes(text), text);
  }
  assert.ok(!json.includes("report.pdf"));
});

void test("quotes nested V2 text, thumbnails, media and files without interactive controls", () => {
  const components: APIMessageTopLevelComponent[] = [{
    type: ComponentType.Container, id: 1, spoiler: true,
    components: [
      { type: ComponentType.TextDisplay, id: 2, content: "V2本文 @everyone <@123>" },
      {
        type: ComponentType.Section,
        components: [{ type: ComponentType.TextDisplay, content: "サムネイルの説明" }],
        accessory: { type: ComponentType.Thumbnail, media: { url: "https://cdn.example.com/thumb.png" } },
      },
      {
        type: ComponentType.Section,
        components: [{ type: ComponentType.TextDisplay, content: "ボタン横の本文" }],
        accessory: { type: ComponentType.Button, style: ButtonStyle.Primary, custom_id: "danger", label: "操作" },
      },
      { type: ComponentType.MediaGallery, items: [{ media: { url: "attachment://pic.jpg" }, spoiler: true, description: "画像説明" }] },
      { type: ComponentType.File, file: { url: "attachment://report.pdf" }, spoiler: true },
      { type: ComponentType.ActionRow, components: [{ type: ComponentType.Button, style: ButtonStyle.Link, url: "https://example.com/", label: "元のボタン" }] },
    ],
  }];
  const source = makeMessage({ components, attachments: [
    { url: "https://cdn.example.com/pic.jpg", name: "pic.jpg", contentType: "image/jpeg" },
    { url: "https://cdn.example.com/report.pdf", name: "report.pdf", contentType: "application/pdf" },
  ] });
  const before = JSON.stringify(components);
  const payload = buildMessageLinkExpansionPayload(source, "general");
  const json = JSON.stringify(payload);
  for (const text of ["V2本文", "サムネイルの説明", "ボタン横の本文", "https://cdn.example.com/thumb.png", "https://cdn.example.com/pic.jpg", "https://cdn.example.com/report.pdf", "画像説明"]) {
    assert.ok(json.includes(text), text);
  }
  for (const text of ["(本文なし)", "custom_id", "元のボタン", "attachment://", '"id":', "accent_color"]) {
    assert.ok(!json.includes(text), text);
  }
  assert.ok(json.includes('"spoiler":true'));
  assert.ok(json.includes("||<https://cdn.example.com/report.pdf>||"));
  assert.equal(JSON.stringify(components), before, "source components must not be mutated");
});

function componentStats(components: readonly APIMessageComponent[]): { count: number; text: number } {
  let count = 0;
  let text = 0;
  for (const component of components) {
    count++;
    if (component.type === ComponentType.TextDisplay) text += component.content.length;
    if (component.type === ComponentType.Container || component.type === ComponentType.Section) {
      const child = componentStats(component.components);
      count += child.count + (component.type === ComponentType.Section ? 1 : 0);
      text += child.text;
    }
  }
  return { count, text };
}

void test("keeps long quotes within Discord's text limit", () => {
  const source = makeMessage({ components: [{ type: ComponentType.TextDisplay, content: "長".repeat(4000) }] });
  const payload = buildMessageLinkExpansionPayload(source, "general");
  const stats = componentStats(payload.components);
  assert.ok(stats.count <= 40, `component count: ${stats.count}`);
  assert.ok(stats.text <= 4000, `text length: ${stats.text}`);
  assert.equal(stats.text, 4000, "retain the quote up to the budget");
  assert.ok(JSON.stringify(payload).includes(source.url), "retain a link to the complete original");
});

void test("counts nested containers and thumbnail accessories against the component limit", () => {
  const source = makeMessage({ components: Array.from({ length: 8 }, () => ({
    type: ComponentType.Container,
    components: [{
      type: ComponentType.Section,
      components: [
        { type: ComponentType.TextDisplay, content: "本文" },
        { type: ComponentType.TextDisplay, content: "続き" },
      ],
      accessory: { type: ComponentType.Thumbnail, media: { url: "https://cdn.example.com/thumb.png" } },
    }],
  })) });
  const payload = buildMessageLinkExpansionPayload(source, "general");
  assert.equal(componentStats(payload.components).count, 40);
});

void test("does not send unresolved attachment references", () => {
  const payload = buildMessageLinkExpansionPayload(makeMessage({ components: [
    { type: ComponentType.MediaGallery, items: [{ media: { url: "attachment://missing.jpg" } }] },
    { type: ComponentType.File, file: { url: "attachment://missing.pdf" } },
  ] }), "general");
  assert.ok(!JSON.stringify(payload).includes("attachment://"));
});

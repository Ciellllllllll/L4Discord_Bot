import assert from "node:assert/strict";
import type { APIEmbed, Message } from "discord.js";
import { buildMessageLinkExpansionPayload } from "./leaveNotifier.js";

function makeMessage(input: {
  content?: string;
  embeds?: APIEmbed[];
  attachments?: Array<{ url: string; name: string; contentType: string }>;
}): Message {
  return {
    content: input.content ?? "",
    createdAt: new Date("2026-06-10T00:00:00.000Z"),
    member: { displayName: "Bot Name" },
    author: {
      username: "bot-user",
      displayAvatarURL: () => "https://cdn.example.com/avatar.png",
    },
    embeds: (input.embeds ?? []).map((embed) => ({ toJSON: () => embed })),
    attachments: {
      values: () => (input.attachments ?? []).map((attachment, index) => ({
        id: String(index),
        url: attachment.url,
        name: attachment.name,
        contentType: attachment.contentType,
      }))[Symbol.iterator](),
    },
  } as unknown as Message;
}

function run(): void {
  const embedOnly = buildMessageLinkExpansionPayload(makeMessage({
    embeds: [{
      title: "通知タイトル",
      description: "通知本文",
      color: 0xff0000,
      image: { url: "https://cdn.example.com/image.png" },
      fields: [{ name: "項目", value: "値", inline: true }],
    }],
  }), "log-channel");
  assert.equal(embedOnly.embeds.length, 1);
  assert.equal(embedOnly.embeds[0]!.toJSON().title, "通知タイトル");
  assert.equal(embedOnly.embeds[0]!.toJSON().description, "通知本文");
  assert.equal(embedOnly.embeds[0]!.toJSON().image?.url, "https://cdn.example.com/image.png");
  assert.equal(embedOnly.files.length, 0);

  const withContentAndAttachments = buildMessageLinkExpansionPayload(makeMessage({
    content: "本文あり",
    attachments: [
      { url: "https://cdn.example.com/pic.jpg", name: "pic.jpg", contentType: "image/jpeg" },
      { url: "https://cdn.example.com/report.pdf", name: "report.pdf", contentType: "application/pdf" },
    ],
  }), "general");
  assert.equal(withContentAndAttachments.embeds.length, 2);
  assert.equal(withContentAndAttachments.embeds[0]!.toJSON().description, "本文あり");
  assert.equal(withContentAndAttachments.embeds[1]!.toJSON().image?.url, "https://cdn.example.com/pic.jpg");
  assert.deepEqual(withContentAndAttachments.files, [{
    attachment: "https://cdn.example.com/report.pdf",
    name: "report.pdf",
  }]);
}

try {
  run();
  console.log("leaveNotifier.spec.ts: all assertions passed");
} catch (err) {
  console.error(err);
  process.exit(1);
}

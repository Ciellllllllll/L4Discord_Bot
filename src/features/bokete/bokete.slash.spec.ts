import assert from "node:assert/strict";
import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { handleBoketeSlash } from "./bokete.slash.js";

type ReplyPayload = {
  content?: string;
  embeds?: unknown[];
  components?: Array<{ type?: number; components?: Array<{ type?: number; content?: string; items?: Array<{ media?: { url?: string } }> }> }>;
  files?: Array<{ name?: string }>;
  flags?: number;
};

type InteractionRecorder = {
  interaction: ChatInputCommandInteraction;
  deferred: boolean;
  deferFlags: number | undefined;
  followUps: ReplyPayload[];
  deleted: boolean;
  replies: ReplyPayload[];
};

const BOKETE_THREAD_ID = "1530637445765398578";

function makeInteraction(channelId = BOKETE_THREAD_ID): InteractionRecorder {
  const replies: ReplyPayload[] = [];
  const followUps: ReplyPayload[] = [];
  let deferred = false;
  let deferFlags: number | undefined;
  let deleted = false;
  return {
    interaction: {
      channelId,
      reply: async (payload: ReplyPayload) => { replies.push(payload); },
      deferReply: async (payload?: { flags?: number }) => {
        deferred = true;
        deferFlags = payload?.flags;
      },
      editReply: async (payload: ReplyPayload) => { replies.push(payload); },
      followUp: async (payload: ReplyPayload) => { followUps.push(payload); },
      deleteReply: async () => { deleted = true; },
    } as unknown as ChatInputCommandInteraction,
    get deferred() { return deferred; },
    get deferFlags() { return deferFlags; },
    get followUps() { return followUps; },
    get deleted() { return deleted; },
    replies,
  };
}

function makeContext(): BotContext {
  return {
    config: {
      BOKETE_API_BASE_URL: "https://bokete.example",
      BOKETE_REQUEST_TIMEOUT_MS: 1_000,
    },
    log: { warn: () => undefined },
  } as unknown as BotContext;
}

async function run(): Promise<void> {
  const restricted = makeInteraction("1397231823968272607");
  await handleBoketeSlash(restricted.interaction, makeContext(), {
    fetcher: async () => {
      throw new Error("指定外のチャンネルでは API を呼び出してはいけません。");
    },
  });
  assert.equal(restricted.deferred, false);
  assert.equal(restricted.replies.length, 1);
  assert.equal(restricted.replies[0]?.content, "このコマンドは指定スレッドでのみ利用できます。");
  assert.equal(restricted.replies[0]?.flags, MessageFlags.Ephemeral);

  const success = makeInteraction();
  await handleBoketeSlash(success.interaction, makeContext(), {
    fetcher: async (input) => String(input).includes("/posts?")
      ? new Response(JSON.stringify([{ text: "本文", image_url: "/posts/1/image" }]), { headers: { "content-type": "application/json" } })
      : new Response(new Uint8Array([1]), { headers: { "content-type": "image/jpeg" } }),
  });
  assert.equal(success.deferred, true);
  assert.equal(success.deferFlags, undefined);
  assert.equal(success.replies.length, 1);
  assert.equal(success.replies[0]?.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(success.replies[0]?.embeds, []);
  assert.equal(success.replies[0]?.components?.[0]?.type, 17);
  assert.equal(success.replies[0]?.components?.[0]?.components?.[0]?.type, 12);
  const gallery = success.replies[0]?.components?.[0]?.components?.find((component) => component.type === 12);
  assert.equal(gallery?.items?.[0]?.media?.url, "attachment://bokete.jpg");
  assert.equal(success.replies[0]?.components?.[0]?.components?.[1]?.content, "# 本文");
  assert.equal(success.replies[0]?.components?.[0]?.components?.at(-1)?.content, "Bokete API by Ciel");
  assert.equal(success.replies[0]?.files?.[0]?.name, "bokete.jpg");
  assert.equal(success.followUps.length, 0);
  assert.equal(success.deleted, false);

  const empty = makeInteraction();
  await handleBoketeSlash(empty.interaction, makeContext(), {
    fetcher: async () => new Response("[]", { headers: { "content-type": "application/json" } }),
  });
  assert.equal(empty.replies[0]?.flags, MessageFlags.IsComponentsV2);
  assert.match(empty.replies[0]?.components?.[0]?.components?.[0]?.content ?? "", /現在利用できる投稿がありません/);

  const failed = makeInteraction();
  await handleBoketeSlash(failed.interaction, makeContext(), {
    fetcher: async () => new Response("error", { status: 503 }),
  });
  assert.equal(failed.replies[0]?.flags, MessageFlags.IsComponentsV2);
  assert.match(failed.replies[0]?.components?.[0]?.components?.[0]?.content ?? "", /投稿の取得に失敗しました/);
  assert.equal(failed.deferFlags, undefined);
}

void run()
  .then(() => console.log("bokete.slash.spec.ts: all assertions passed"))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

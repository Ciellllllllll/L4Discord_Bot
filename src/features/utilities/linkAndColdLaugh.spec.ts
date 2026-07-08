import assert from "node:assert/strict";
import {
  LinkAndColdLaugh,
  coldLaughHitsForMessageContent,
  extractXLinks,
  extractYouTubeLinks,
  stripLinksForColdLaughContent,
} from "./linkAndColdLaugh.js";

function createDb(settings: Record<string, unknown> = {}): unknown {
  return {
    selectFrom: () => ({
      selectAll: () => ({
        where: () => ({
          executeTakeFirst: async () => ({
            guild_id: "guild-1",
            data: JSON.stringify(settings),
          }),
        }),
      }),
    }),
  };
}

function createCtx(overrides: Record<string, unknown> = {}): unknown {
  return {
    config: {
      COLD_LAUGH_STORE_PATH: "NUL",
      GUILD_ID: "guild-1",
      YOUTUBE_PREVIEW_ENABLED: true,
      YOUTUBE_DATA_API_KEY: "",
      YOUTUBE_REQUEST_TIMEOUT_MS: 10,
      ...overrides,
    },
    db: createDb(),
    log: {
      error: () => {},
      warn: () => {},
    },
  };
}

async function run(): Promise<void> {
  assert.equal(coldLaughHitsForMessageContent("https://example.com/落ち着けw"), 0);
  assert.equal(coldLaughHitsForMessageContent("x.com/user/status/123/落ち着けw"), 0);
  assert.equal(coldLaughHitsForMessageContent("www.example.com/怒んなやw"), 0);
  assert.equal(coldLaughHitsForMessageContent("discord.gg/落ち着けw"), 0);
  assert.equal(coldLaughHitsForMessageContent("youtu.be/落ち着けw"), 0);
  assert.equal(coldLaughHitsForMessageContent("youtube.com/watch?v=怒んなやw"), 0);
  assert.equal(coldLaughHitsForMessageContent("music.youtube.com/watch?v=落ち着けw"), 0);
  assert.equal(coldLaughHitsForMessageContent("notyoutube.com/watch?v=落ち着けw"), 2);
  assert.equal(coldLaughHitsForMessageContent("notyoutube.com?u=youtube.com/watch?v=落ち着けw"), 2);
  assert.equal(coldLaughHitsForMessageContent("example.com?next=youtube.com/watch?v=落ち着けw"), 2);
  assert.equal(coldLaughHitsForMessageContent("abc#youtube.com/watch?v=落ち着けw"), 2);

  assert.equal(coldLaughHitsForMessageContent("落ち着けw https://example.com/post"), 2);
  assert.equal(coldLaughHitsForMessageContent("https://example.com/post 怒んなやw"), 1);

  assert.equal(stripLinksForColdLaughContent("see https://example.com/落ち着けw now").trim(), "see   now");
  assert.equal(stripLinksForColdLaughContent("see youtu.be/落ち着けw now").trim(), "see   now");
  assert.equal(stripLinksForColdLaughContent("see notyoutube.com/watch?v=落ち着けw now"), "see notyoutube.com/watch?v=落ち着けw now");
  assert.equal(
    stripLinksForColdLaughContent("see notyoutube.com?u=youtube.com/watch?v=落ち着けw now"),
    "see notyoutube.com?u=youtube.com/watch?v=落ち着けw now",
  );
  assert.equal(
    stripLinksForColdLaughContent("see example.com?next=youtube.com/watch?v=落ち着けw now"),
    "see example.com?next=youtube.com/watch?v=落ち着けw now",
  );
  assert.equal(
    stripLinksForColdLaughContent("see abc#youtube.com/watch?v=落ち着けw now"),
    "see abc#youtube.com/watch?v=落ち着けw now",
  );

  const mixed = "x.com/user/status/123 youtube.com/watch?v=abc youtu.be/def www.youtu.be/ghi twitter.com/user/status/456";
  assert.deepEqual(extractXLinks(mixed), [
    "x.com/user/status/123",
    "twitter.com/user/status/456",
  ]);
  assert.deepEqual(extractYouTubeLinks(mixed), [
    "youtube.com/watch?v=abc",
    "youtu.be/def",
    "www.youtu.be/ghi",
  ]);
  assert.deepEqual(extractYouTubeLinks("notyoutube.com/watch?v=落ち着けw"), []);
  assert.deepEqual(extractYouTubeLinks("notyoutube.com?u=youtube.com/watch?v=落ち着けw"), []);
  assert.deepEqual(extractYouTubeLinks("example.com?next=youtube.com/watch?v=落ち着けw"), []);
  assert.deepEqual(extractYouTubeLinks("abc#youtube.com/watch?v=落ち着けw"), []);
  assert.deepEqual(extractYouTubeLinks("https://example.com/path/youtube.com/watch?v=落ち着けw"), []);
  assert.deepEqual(extractYouTubeLinks("https://youtube.com/watch?v=scheme"), [
    "https://youtube.com/watch?v=scheme",
  ]);
  assert.deepEqual(extractYouTubeLinks([
    "youtube.com/watch?v=start",
    " youtube.com/watch?v=space",
    "\u3000youtube.com/watch?v=fullwidth-space",
    "<youtube.com/watch?v=angle",
    "(youtube.com/watch?v=paren",
    "[youtube.com/watch?v=bracket",
    "{youtube.com/watch?v=brace",
    "\"youtube.com/watch?v=double-quote",
    "'youtube.com/watch?v=single-quote",
  ].join(" ")), [
    "youtube.com/watch?v=start",
    "youtube.com/watch?v=space",
    "youtube.com/watch?v=fullwidth-space",
    "youtube.com/watch?v=angle",
    "youtube.com/watch?v=paren",
    "youtube.com/watch?v=bracket",
    "youtube.com/watch?v=brace",
    "youtube.com/watch?v=double-quote",
    "youtube.com/watch?v=single-quote",
  ]);
  assert.deepEqual(extractYouTubeLinks([
    "youtube.com/watch?v=bare",
    "www.youtube.com/watch?v=www",
    "m.youtube.com/watch?v=mobile",
    "music.youtube.com/watch?v=music",
    "youtu.be/short",
    "www.youtu.be/www-short",
    "https://youtube.com/watch?v=scheme",
    "https://www.youtube.com/watch?v=scheme-www",
    "https://m.youtube.com/watch?v=scheme-mobile",
    "https://music.youtube.com/watch?v=scheme-music",
    "https://youtu.be/scheme-short",
    "https://www.youtu.be/scheme-www-short",
  ].join(" ")), [
    "youtube.com/watch?v=bare",
    "www.youtube.com/watch?v=www",
    "m.youtube.com/watch?v=mobile",
    "music.youtube.com/watch?v=music",
    "youtu.be/short",
    "www.youtu.be/www-short",
    "https://youtube.com/watch?v=scheme",
    "https://www.youtube.com/watch?v=scheme-www",
    "https://m.youtube.com/watch?v=scheme-mobile",
    "https://music.youtube.com/watch?v=scheme-music",
    "https://youtu.be/scheme-short",
    "https://www.youtu.be/scheme-www-short",
  ]);

  const replies: unknown[] = [];
  let suppressCalls = 0;
  const message = {
    author: { bot: false, id: "user-1" },
    guild: { id: "guild-1" },
    channelId: "channel-1",
    content: "x.com/profile youtube.com/c/custom",
    suppressEmbeds: async (value: boolean) => {
      assert.equal(value, true);
      suppressCalls += 1;
    },
    reply: async (payload: unknown) => {
      replies.push(payload);
    },
  };
  await new LinkAndColdLaugh(createCtx() as never).onMessage(message as never);
  assert.equal(suppressCalls, 1);
  assert.deepEqual(replies.map((payload) => (payload as { content?: string }).content), [
    "https://vxtwitter.com/profile",
    "https://www.youtube.com/c/custom",
  ]);

  const youtubeDisabledReplies: unknown[] = [];
  const youtubeDisabledMessage = {
    ...message,
    content: "youtube.com/c/custom",
    suppressEmbeds: async () => {
      throw new Error("suppress should not be called");
    },
    reply: async (payload: unknown) => {
      youtubeDisabledReplies.push(payload);
    },
  };
  await new LinkAndColdLaugh(createCtx({ YOUTUBE_PREVIEW_ENABLED: false }) as never).onMessage(youtubeDisabledMessage as never);
  assert.deepEqual(youtubeDisabledReplies, []);
}

try {
  await run();
  console.log("linkAndColdLaugh.spec.ts: all assertions passed");
} catch (err) {
  console.error(err);
  process.exit(1);
}

import assert from "node:assert/strict";
import {
  resolveYouTubeVideoMedia,
  type YouTubeStreamingClient,
  type YouTubeStreamingFormat,
} from "./youtubeVideoMedia.js";

type StreamingCall = {
  videoId: string;
  options: {
    type: "video+audio";
    format: "mp4";
    quality: string;
  };
};

function makeClient(
  formats: Record<string, YouTubeStreamingFormat | Error>,
  calls: StreamingCall[],
): YouTubeStreamingClient {
  return {
    async getStreamingData(videoId, options) {
      calls.push({ videoId, options });
      const format = formats[options.quality];
      if (format instanceof Error) throw format;
      if (!format) throw new Error("quality not found");
      return format;
    },
  };
}

function factoryFor(client: YouTubeStreamingClient): () => Promise<YouTubeStreamingClient> {
  return async () => client;
}

async function run(): Promise<void> {
  const positiveCalls: StreamingCall[] = [];
  const positive = await resolveYouTubeVideoMedia("https://www.youtube.com/watch?v=inner-tube", {
    maxBytes: 50 * 1024 * 1024,
    timeoutMs: 4_321,
    clientFactory: factoryFor(makeClient({
      "720p": {
        url: "https://rr.example.googlevideo.com/video-720.mp4",
        mime_type: "video/mp4; codecs=\"avc1, mp4a\"",
        height: 720,
        has_video: true,
        has_audio: true,
        content_length: 20 * 1024 * 1024,
      },
    }, positiveCalls)),
  });
  assert.deepEqual(positive, {
    status: "ok",
    mediaUrl: "https://rr.example.googlevideo.com/video-720.mp4",
  });
  assert.deepEqual(positiveCalls, [{
    videoId: "inner-tube",
    options: { type: "video+audio", format: "mp4", quality: "720p" },
  }]);

  const sizeCalls: StreamingCall[] = [];
  const sizeLimited = await resolveYouTubeVideoMedia("https://www.youtube.com/watch?v=size-limited", {
    maxBytes: 10 * 1024 * 1024,
    clientFactory: factoryFor(makeClient({
      "720p": {
        url: "https://rr.example.googlevideo.com/video-720.mp4",
        mime_type: "video/mp4",
        height: 720,
        has_video: true,
        has_audio: true,
        content_length: 30 * 1024 * 1024,
      },
      "480p": {
        url: "https://rr.example.googlevideo.com/video-480.mp4",
        mime_type: "video/mp4",
        height: 480,
        has_video: true,
        has_audio: true,
        content_length: 9 * 1024 * 1024,
      },
    }, sizeCalls)),
  });
  assert.deepEqual(sizeLimited, {
    status: "ok",
    mediaUrl: "https://rr.example.googlevideo.com/video-480.mp4",
  });
  assert.deepEqual(sizeCalls.map((call) => call.options.quality), ["720p", "480p"]);

  const fallbackCases: Array<{
    name: string;
    url: string;
    reason: "invalid_url" | "no_suitable_format" | "inner_tube_error" | "timeout";
    client?: YouTubeStreamingClient;
    timeoutMs?: number;
  }> = [
    {
      name: "HTTP URL",
      url: "http://www.youtube.com/watch?v=http",
      reason: "invalid_url",
    },
    {
      name: "video only",
      url: "https://www.youtube.com/watch?v=video-only",
      reason: "no_suitable_format",
      client: makeClient({
        "720p": {
          url: "https://rr.example.googlevideo.com/video-only.mp4",
          mime_type: "video/mp4",
          height: 720,
          has_video: true,
          has_audio: false,
        },
      }, []),
    },
    {
      name: "webm only",
      url: "https://www.youtube.com/watch?v=webm-only",
      reason: "no_suitable_format",
      client: makeClient({
        "720p": {
          url: "https://rr.example.googlevideo.com/video-only.webm",
          mime_type: "video/webm",
          height: 720,
          has_video: true,
          has_audio: true,
        },
      }, []),
    },
    {
      name: "InnerTube error",
      url: "https://www.youtube.com/watch?v=inner-tube-error",
      reason: "inner_tube_error",
      client: makeClient({
        "720p": new Error("blocked"),
        "480p": new Error("blocked"),
        "360p": new Error("blocked"),
        "240p": new Error("blocked"),
        "144p": new Error("blocked"),
      }, []),
    },
  ];

  for (const fallbackCase of fallbackCases) {
    const result = await resolveYouTubeVideoMedia(fallbackCase.url, {
      clientFactory: fallbackCase.client ? factoryFor(fallbackCase.client) : undefined,
      timeoutMs: fallbackCase.timeoutMs,
    });
    assert.deepEqual(result, { status: "fallback", reason: fallbackCase.reason }, fallbackCase.name);
  }

  const timeoutClient: YouTubeStreamingClient = {
    getStreamingData: () => new Promise<YouTubeStreamingFormat>(() => undefined),
  };
  const timeout = await resolveYouTubeVideoMedia("https://www.youtube.com/watch?v=timeout", {
    clientFactory: factoryFor(timeoutClient),
    timeoutMs: 10,
  });
  assert.deepEqual(timeout, { status: "fallback", reason: "timeout" });

  let now = 1_000;
  let cacheFactoryCalls = 0;
  let cacheClientCalls = 0;
  const cacheClient: YouTubeStreamingClient = {
    async getStreamingData(_videoId, _options) {
      cacheClientCalls += 1;
      return {
        url: `https://rr.example.googlevideo.com/cache-${cacheClientCalls}.mp4`,
        mime_type: "video/mp4",
        height: 360,
        has_video: true,
        has_audio: true,
      };
    },
  };
  const cacheOptions = {
    clientFactory: async () => {
      cacheFactoryCalls += 1;
      return cacheClient;
    },
    nowMs: () => now,
  };
  const cacheUrl = "https://www.youtube.com/watch?v=cache-me";
  assert.equal((await resolveYouTubeVideoMedia(cacheUrl, cacheOptions)).status, "ok");
  assert.equal((await resolveYouTubeVideoMedia(cacheUrl, cacheOptions)).status, "ok");
  assert.equal(cacheFactoryCalls, 1);
  assert.equal(cacheClientCalls, 1);
  now += 5 * 60 * 1000 + 1;
  assert.equal((await resolveYouTubeVideoMedia(cacheUrl, cacheOptions)).status, "ok");
  assert.equal(cacheFactoryCalls, 2);
  assert.equal(cacheClientCalls, 2);
}

run()
  .then(() => {
    console.log("youtubeVideoMedia.spec.ts: all assertions passed");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

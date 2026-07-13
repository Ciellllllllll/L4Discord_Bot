import assert from "node:assert/strict";
import {
  resolveYouTubeVideoMedia,
  type YtDlpRunner,
} from "./youtubeVideoMedia.js";

type RunnerCall = {
  command: string;
  args: readonly string[];
  options: { timeoutMs: number; maxBuffer: number };
};

function makeJson(formats: unknown): string {
  return JSON.stringify({ formats });
}

async function run(): Promise<void> {
  const positiveCalls: RunnerCall[] = [];
  const positiveRunner: YtDlpRunner = async (command, args, options) => {
    positiveCalls.push({ command, args, options });
    return {
      stdout: makeJson([
        { url: "https://media.example.com/video-480.mp4", ext: "mp4", vcodec: "avc1", acodec: "aac", height: 480, tbr: 1000 },
        { url: "https://media.example.com/video-720.mp4", ext: "mp4", vcodec: "avc1", acodec: "aac", height: 720, tbr: 1500 },
        { url: "https://media.example.com/video-720-better.mp4", ext: "mp4", vcodec: "avc1", acodec: "aac", height: 720, tbr: 2000 },
        { url: "https://media.example.com/video-1080.mp4", ext: "mp4", vcodec: "avc1", acodec: "aac", height: 1080, tbr: 9999 },
        { url: "https://media.example.com/video-webm.webm", ext: "webm", vcodec: "vp9", acodec: "opus", height: 720 },
      ]),
    };
  };
  const positive = await resolveYouTubeVideoMedia("https://www.youtube.com/watch?v=abc123", {
    ytdlpPath: "custom-ytdlp",
    timeoutMs: 4321,
    runner: positiveRunner,
  });
  assert.deepEqual(positive, { status: "ok", mediaUrl: "https://media.example.com/video-720-better.mp4" });
  assert.equal(positiveCalls.length, 1);
  assert.equal(positiveCalls[0]?.command, "custom-ytdlp");
  assert.deepEqual(positiveCalls[0]?.args, [
    "--dump-single-json",
    "--no-playlist",
    "--skip-download",
    "--no-warnings",
    "https://www.youtube.com/watch?v=abc123",
  ]);
  assert.equal(positiveCalls[0]?.options.timeoutMs, 4321);
  assert.equal(positiveCalls[0]?.options.maxBuffer > 0, true);

  const fallbackCases: Array<{
    name: string;
    url: string;
    reason: "invalid_url" | "cli_error" | "timeout" | "invalid_json" | "no_suitable_format";
    stdout?: string;
    runner?: YtDlpRunner;
  }> = [
    {
      name: "video-only",
      url: "https://www.youtube.com/watch?v=video-only",
      reason: "no_suitable_format",
      stdout: makeJson([{ url: "https://media.example.com/video-only.mp4", ext: "mp4", vcodec: "avc1", acodec: "none", height: 720 }]),
    },
    {
      name: "vcodec missing",
      url: "https://www.youtube.com/watch?v=vcodec-missing",
      reason: "no_suitable_format",
      stdout: makeJson([{ url: "https://media.example.com/vcodec-missing.mp4", ext: "mp4", acodec: "aac", height: 720 }]),
    },
    {
      name: "acodec empty",
      url: "https://www.youtube.com/watch?v=acodec-empty",
      reason: "no_suitable_format",
      stdout: makeJson([{ url: "https://media.example.com/acodec-empty.mp4", ext: "mp4", vcodec: "avc1", acodec: "", height: 720 }]),
    },
    {
      name: "vcodec null",
      url: "https://www.youtube.com/watch?v=vcodec-null",
      reason: "no_suitable_format",
      stdout: makeJson([{ url: "https://media.example.com/vcodec-null.mp4", ext: "mp4", vcodec: null, acodec: "aac", height: 720 }]),
    },
    {
      name: "audio-only",
      url: "https://www.youtube.com/watch?v=audio-only",
      reason: "no_suitable_format",
      stdout: makeJson([{ url: "https://media.example.com/audio-only.mp4", ext: "mp4", vcodec: "none", acodec: "aac", height: 720 }]),
    },
    {
      name: "webm only",
      url: "https://www.youtube.com/watch?v=webm-only",
      reason: "no_suitable_format",
      stdout: makeJson([{ url: "https://media.example.com/webm-only.webm", ext: "webm", vcodec: "vp9", acodec: "aac", height: 720 }]),
    },
    {
      name: "m3u8 only",
      url: "https://www.youtube.com/watch?v=m3u8-only",
      reason: "no_suitable_format",
      stdout: makeJson([{ url: "https://media.example.com/master.m3u8", ext: "mp4", vcodec: "avc1", acodec: "aac", height: 720 }]),
    },
    {
      name: "720p超のみ",
      url: "https://www.youtube.com/watch?v=over-720",
      reason: "no_suitable_format",
      stdout: makeJson([{ url: "https://media.example.com/over-1080.mp4", ext: "mp4", vcodec: "avc1", acodec: "aac", height: 1080 }]),
    },
    {
      name: "空 formats",
      url: "https://www.youtube.com/watch?v=empty",
      reason: "no_suitable_format",
      stdout: makeJson([]),
    },
    {
      name: "不正 JSON",
      url: "https://www.youtube.com/watch?v=bad-json",
      reason: "invalid_json",
      stdout: "{",
    },
    {
      name: "CLI error",
      url: "https://www.youtube.com/watch?v=cli-error",
      reason: "cli_error",
      runner: async () => {
        throw new Error("boom");
      },
    },
    {
      name: "timeout",
      url: "https://www.youtube.com/watch?v=timeout",
      reason: "timeout",
      runner: async () => {
        const error = new Error("process timed out");
        (error as { code?: string }).code = "ETIMEDOUT";
        throw error;
      },
    },
    {
      name: "http URL",
      url: "http://www.youtube.com/watch?v=http",
      reason: "invalid_url",
    },
  ];

  for (const fallbackCase of fallbackCases) {
    const calls: RunnerCall[] = [];
    const runner: YtDlpRunner = fallbackCase.runner ?? (async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: fallbackCase.stdout ?? makeJson([]) };
    });
    const result = await resolveYouTubeVideoMedia(fallbackCase.url, {
      runner,
      timeoutMs: 1000,
    });
    assert.deepEqual(result, { status: "fallback", reason: fallbackCase.reason }, fallbackCase.name);
    if (fallbackCase.url.startsWith("http://")) {
      assert.equal(calls.length, 0, fallbackCase.name);
    }
  }

  let now = 1_000;
  let cacheCalls = 0;
  const cacheRunner: YtDlpRunner = async () => {
    cacheCalls += 1;
    return {
      stdout: makeJson([
        { url: `https://media.example.com/cache-${cacheCalls}.mp4`, ext: "mp4", vcodec: "avc1", acodec: "aac", height: 720 },
      ]),
    };
  };
  const cacheOptions = {
    runner: cacheRunner,
    nowMs: () => now,
  };
  const cacheUrl = "https://www.youtube.com/watch?v=cache-me";
  assert.equal((await resolveYouTubeVideoMedia(cacheUrl, cacheOptions)).status, "ok");
  assert.equal((await resolveYouTubeVideoMedia(cacheUrl, cacheOptions)).status, "ok");
  assert.equal(cacheCalls, 1);
  now += 5 * 60 * 1000 + 1;
  assert.equal((await resolveYouTubeVideoMedia(cacheUrl, cacheOptions)).status, "ok");
  assert.equal(cacheCalls, 2);

  let disabledCalls = 0;
  const disabled = await resolveYouTubeVideoMedia("https://www.youtube.com/watch?v=disabled", {
    enabled: false,
    runner: async () => {
      disabledCalls += 1;
      return { stdout: makeJson([]) };
    },
  });
  assert.deepEqual(disabled, { status: "fallback", reason: "disabled" });
  assert.equal(disabledCalls, 0);
}

run()
  .then(() => {
    console.log("youtubeVideoMedia.spec.ts: all assertions passed");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

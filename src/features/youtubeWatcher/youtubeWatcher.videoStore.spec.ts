import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as videoStore from "./youtubeWatcher.videoStore.js";

const { cleanupYouTubeVideoCache, persistYouTubeVideo } = videoStore;

const publicBaseUrl = "https://media.example/adhd/";

function publicResponse(headers: Record<string, string> = {}): Response {
  return new Response(null, {
    status: 200,
    headers: {
      "content-type": "video/mp4",
      "accept-ranges": "bytes",
      ...headers,
    },
  });
}

function publicRangeResponse(total: number, headers: Record<string, string> = {}): Response {
  return new Response(Buffer.from("x"), {
    status: 206,
    headers: {
      "content-type": "video/mp4",
      "content-range": `bytes 0-0/${total}`,
      ...headers,
    },
  });
}

function verifiedPublicResponse(init: RequestInit | undefined, total: number): Response {
  return init?.method === "HEAD" ? publicResponse() : publicRangeResponse(total);
}

test("persistYouTubeVideo stores a resolved MP4 atomically and returns its durable URL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adhd-video-store-"));
  try {
    const fetchCalls: Array<{ url: string; method: string }> = [];
    const result = await persistYouTubeVideo({
      videoId: "video_1-abc",
      videoUrl: "https://www.youtube.com/watch?v=video_1-abc",
    }, {
      directory,
      publicBaseUrl,
      timeoutMs: 1_000,
      minFreeBytes: 100,
      mediaResolver: async () => ({ status: "ok", mediaUrl: "https://rr.example.googlevideo.com/source.mp4" }),
      statfs: async () => ({ bavail: 10, bsize: 100 } as never),
      fetcher: async (input, init) => {
        const url = String(input);
        fetchCalls.push({ url, method: init?.method ?? "GET" });
        if (url.includes("googlevideo.com")) {
          return new Response(Buffer.from("video-data"), {
            status: 200,
            headers: { "content-type": "Video/MP4; charset=binary", "content-length": "10" },
          });
        }
        return verifiedPublicResponse(init, 10);
      },
    });

    assert.deepEqual(result, {
      status: "cached",
      mediaUrl: "https://media.example/adhd/video_1-abc.mp4",
      evictedVideoIds: [],
    });
    assert.equal((await readFile(join(directory, "video_1-abc.mp4"))).toString(), "video-data");
    assert.deepEqual(await readdir(directory), ["video_1-abc.mp4"]);
    assert.deepEqual(fetchCalls, [
      { url: "https://rr.example.googlevideo.com/source.mp4", method: "GET" },
      { url: "https://media.example/adhd/video_1-abc.mp4", method: "HEAD" },
      { url: "https://media.example/adhd/video_1-abc.mp4", method: "GET" },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persistYouTubeVideo reuses an existing file without resolving or downloading it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adhd-video-store-"));
  try {
    await writeFile(join(directory, "existing.mp4"), "stored");
    const mtimeBeforeReuse = (await stat(join(directory, "existing.mp4"))).mtimeMs;
    let resolverCalls = 0;
    const result = await persistYouTubeVideo({
      videoId: "existing",
      videoUrl: "https://www.youtube.com/watch?v=existing",
    }, {
      directory,
      publicBaseUrl,
      timeoutMs: 1_000,
      minFreeBytes: 100,
      mediaResolver: async () => {
        resolverCalls += 1;
        return { status: "fallback", reason: "unexpected" };
      },
      fetcher: async (_input, init) => verifiedPublicResponse(init, 6),
    });

    assert.deepEqual(result, {
      status: "cached",
      mediaUrl: "https://media.example/adhd/existing.mp4",
      evictedVideoIds: [],
    });
    assert.equal(resolverCalls, 0);
    assert.equal((await stat(join(directory, "existing.mp4"))).mtimeMs, mtimeBeforeReuse);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persistYouTubeVideo refuses unsafe IDs, non-HTTPS publishing, and insufficient disk space", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adhd-video-store-"));
  try {
    const common = {
      directory,
      publicBaseUrl,
      timeoutMs: 1_000,
      minFreeBytes: 100,
      mediaResolver: async () => ({ status: "ok" as const, mediaUrl: "https://rr.example.googlevideo.com/source.mp4" }),
      fetcher: async () => new Response(Buffer.alloc(200), {
        status: 200,
        headers: { "content-type": "video/mp4", "content-length": "200" },
      }),
    };

    assert.deepEqual(await persistYouTubeVideo({ videoId: "../escape", videoUrl: "https://youtu.be/x" }, common), {
      status: "fallback",
      reason: "invalid_video_id",
      evictedVideoIds: [],
    });
    assert.deepEqual(await persistYouTubeVideo({ videoId: "safe", videoUrl: "https://youtu.be/x" }, {
      ...common,
      publicBaseUrl: "http://media.example/adhd/",
    }), { status: "fallback", reason: "invalid_public_base_url", evictedVideoIds: [] });
    assert.deepEqual(await persistYouTubeVideo({ videoId: "no-space", videoUrl: "https://youtu.be/x" }, {
      ...common,
      statfs: async () => ({ bavail: 2, bsize: 100 } as never),
    }), {
      status: "fallback",
      reason: "insufficient_disk_space",
      googleVideoUrl: "https://rr.example.googlevideo.com/source.mp4",
      evictedVideoIds: [],
    });
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persistYouTubeVideo removes a partial file after a broken source stream", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adhd-video-store-"));
  try {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        controller.error(new Error("stream failed"));
      },
    });
    const result = await persistYouTubeVideo({ videoId: "broken", videoUrl: "https://youtu.be/x" }, {
      directory,
      publicBaseUrl,
      timeoutMs: 1_000,
      minFreeBytes: 0,
      statfs: async () => ({ bavail: 100, bsize: 1 } as never),
      mediaResolver: async () => ({ status: "ok", mediaUrl: "https://rr.example.googlevideo.com/source.mp4" }),
      fetcher: async () => new Response(broken, {
        status: 200,
        headers: { "content-type": "video/mp4", "content-length": "7" },
      }),
    });

    assert.deepEqual(result, {
      status: "fallback",
      reason: "download_error",
      googleVideoUrl: "https://rr.example.googlevideo.com/source.mp4",
      evictedVideoIds: [],
    });
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persistYouTubeVideo times out while the source body is still streaming", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adhd-video-store-"));
  try {
    let delayedChunk: ReturnType<typeof setTimeout> | undefined;
    const slow = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("a"));
        delayedChunk = setTimeout(() => {
          controller.enqueue(new TextEncoder().encode("b"));
          controller.close();
        }, 150);
      },
      cancel() {
        if (delayedChunk) clearTimeout(delayedChunk);
      },
    });
    const startedAt = Date.now();
    const result = await persistYouTubeVideo({ videoId: "slow", videoUrl: "https://youtu.be/x" }, {
      directory,
      publicBaseUrl,
      timeoutMs: 20,
      minFreeBytes: 0,
      statfs: async () => ({ bavail: 100, bsize: 1 } as never),
      mediaResolver: async () => ({ status: "ok", mediaUrl: "https://rr.example.googlevideo.com/source.mp4" }),
      fetcher: async () => new Response(slow, {
        status: 200,
        headers: { "content-type": "video/mp4", "content-length": "2" },
      }),
    });

    assert.deepEqual(result, {
      status: "fallback",
      reason: "download_error",
      googleVideoUrl: "https://rr.example.googlevideo.com/source.mp4",
      evictedVideoIds: [],
    });
    assert.ok(Date.now() - startedAt < 120, "本文の待機中もtimeoutMsで中断する");
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persistYouTubeVideo aborts as soon as the source exceeds its declared size", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adhd-video-store-"));
  try {
    let cancelled = false;
    let delayedClose: ReturnType<typeof setTimeout> | undefined;
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("12345"));
        delayedClose = setTimeout(() => controller.close(), 150);
      },
      cancel() {
        cancelled = true;
        if (delayedClose) clearTimeout(delayedClose);
      },
    });
    const result = await persistYouTubeVideo({ videoId: "oversized-body", videoUrl: "https://youtu.be/x" }, {
      directory,
      publicBaseUrl,
      timeoutMs: 1_000,
      minFreeBytes: 0,
      statfs: async () => ({ bavail: 100, bsize: 1 } as never),
      mediaResolver: async () => ({ status: "ok", mediaUrl: "https://rr.example.googlevideo.com/source.mp4" }),
      fetcher: async () => new Response(oversized, {
        status: 200,
        headers: { "content-type": "video/mp4", "content-length": "4" },
      }),
    });

    assert.equal(result.status, "fallback");
    assert.equal(cancelled, true);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persistYouTubeVideo rejects a public URL when HEAD headers claim byte ranges but Range GET does not", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adhd-video-store-"));
  try {
    await writeFile(join(directory, "no-ranges.mp4"), "stored");
    let resolverCalls = 0;
    const result = await persistYouTubeVideo({ videoId: "no-ranges", videoUrl: "https://youtu.be/x" }, {
      directory,
      publicBaseUrl,
      timeoutMs: 1_000,
      minFreeBytes: 0,
      mediaResolver: async () => {
        resolverCalls += 1;
        return { status: "ok" as const, mediaUrl: "https://rr.example.googlevideo.com/source.mp4" };
      },
      fetcher: async (_input, init) => init?.method === "HEAD"
        ? publicResponse()
        : publicResponse(),
    });
    assert.deepEqual(result, {
      status: "fallback",
      reason: "public_range_http_200",
      googleVideoUrl: "https://rr.example.googlevideo.com/source.mp4",
      evictedVideoIds: [],
    });
    assert.equal(resolverCalls, 1);
    assert.deepEqual(await readdir(directory), ["no-ranges.mp4"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("planYouTubeVideoCacheCleanup removes expired files before capacity eviction at the 30-day boundary", () => {
  const planner = (videoStore as Record<string, unknown>).planYouTubeVideoCacheCleanup;
  assert.equal(typeof planner, "function");
  const nowMs = Date.UTC(2026, 7, 16, 0, 0, 0);
  const gib = 1024 ** 3;
  const result = (planner as (files: unknown, options: unknown) => unknown)([
    { videoId: "expired", size: 15 * gib, mtimeMs: nowMs - 30 * 24 * 60 * 60 * 1000 },
    { videoId: "old", size: 4 * gib, mtimeMs: nowMs - 1_000 },
  ], {
    nowMs,
    retentionDays: 30,
    maxBytes: 8 * gib,
    incomingBytes: 4 * gib,
  });
  assert.deepEqual(result, { canStore: true, evictedVideoIds: ["expired"] });
});

test("planYouTubeVideoCacheCleanup keeps an exact 20 GiB total and evicts multiple oldest files when needed", () => {
  const planner = (videoStore as Record<string, unknown>).planYouTubeVideoCacheCleanup;
  assert.equal(typeof planner, "function");
  const nowMs = Date.UTC(2026, 7, 16, 0, 0, 0);
  const gib = 1024 ** 3;
  const exactBoundary = (planner as (files: unknown, options: unknown) => unknown)([
    { videoId: "stored", size: 18 * gib, mtimeMs: nowMs - 1_000 },
  ], { nowMs, retentionDays: 30, maxBytes: 20 * gib, incomingBytes: 2 * gib });
  assert.deepEqual(exactBoundary, { canStore: true, evictedVideoIds: [] });

  const multipleEvictions = (planner as (files: unknown, options: unknown) => unknown)([
    { videoId: "oldest", size: 3 * gib, mtimeMs: nowMs - 3_000 },
    { videoId: "middle", size: 3 * gib, mtimeMs: nowMs - 2_000 },
    { videoId: "newest", size: 16 * gib, mtimeMs: nowMs - 1_000 },
  ], { nowMs, retentionDays: 30, maxBytes: 20 * gib, incomingBytes: 4 * gib });
  assert.deepEqual(multipleEvictions, { canStore: true, evictedVideoIds: ["oldest", "middle"] });
});

test("planYouTubeVideoCacheCleanup does not evict retained files for a single video larger than the cache", () => {
  const planner = (videoStore as Record<string, unknown>).planYouTubeVideoCacheCleanup;
  assert.equal(typeof planner, "function");
  const nowMs = Date.UTC(2026, 7, 16, 0, 0, 0);
  const gib = 1024 ** 3;
  const result = (planner as (files: unknown, options: unknown) => unknown)([
    { videoId: "retained", size: 10 * gib, mtimeMs: nowMs - 1_000 },
  ], { nowMs, retentionDays: 30, maxBytes: 20 * gib, incomingBytes: 21 * gib });
  assert.deepEqual(result, { canStore: false, evictedVideoIds: [] });
});

test("persistYouTubeVideo evicts filesystem-oldest files, ignores parts for capacity, and removes a one-hour-old part", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adhd-video-store-"));
  try {
    const nowMs = Date.UTC(2026, 7, 16, 0, 0, 0);
    await writeFile(join(directory, "old.mp4"), "old-data");
    await writeFile(join(directory, "new.mp4"), "new-data");
    await writeFile(join(directory, "fresh.mp4.part"), Buffer.alloc(100));
    await writeFile(join(directory, "stale.mp4.part"), Buffer.alloc(100));
    await utimes(join(directory, "old.mp4"), new Date(nowMs - 2_000), new Date(nowMs - 2_000));
    await utimes(join(directory, "new.mp4"), new Date(nowMs - 1_000), new Date(nowMs - 1_000));
    await utimes(join(directory, "fresh.mp4.part"), new Date(nowMs - 3_599_999), new Date(nowMs - 3_599_999));
    await utimes(join(directory, "stale.mp4.part"), new Date(nowMs - 3_600_000), new Date(nowMs - 3_600_000));

    const result = await persistYouTubeVideo({ videoId: "incoming", videoUrl: "https://youtu.be/incoming" }, {
      directory,
      publicBaseUrl,
      timeoutMs: 1_000,
      minFreeBytes: 0,
      cacheMaxBytes: 16,
      retentionDays: 30,
      now: () => nowMs,
      statfs: async () => ({ bavail: 100, bsize: 1 } as never),
      mediaResolver: async () => ({ status: "ok", mediaUrl: "https://rr.example.googlevideo.com/source.mp4" }),
      fetcher: async (input, init) => String(input).includes("googlevideo.com")
        ? new Response(Buffer.from("incoming"), { status: 200, headers: { "content-type": "video/mp4", "content-length": "8" } })
        : verifiedPublicResponse(init, 8),
    });

    assert.deepEqual(result, {
      status: "cached",
      mediaUrl: "https://media.example/adhd/incoming.mp4",
      evictedVideoIds: ["old"],
    });
    assert.deepEqual((await readdir(directory)).sort(), ["fresh.mp4.part", "incoming.mp4", "new.mp4"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persistYouTubeVideo falls back without evicting retained files for an oversized video", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adhd-video-store-"));
  try {
    await writeFile(join(directory, "retained.mp4"), "stored");
    const result = await persistYouTubeVideo({ videoId: "oversized", videoUrl: "https://youtu.be/oversized" }, {
      directory,
      publicBaseUrl,
      timeoutMs: 1_000,
      minFreeBytes: 0,
      cacheMaxBytes: 4,
      retentionDays: 30,
      statfs: async () => ({ bavail: 100, bsize: 1 } as never),
      mediaResolver: async () => ({ status: "ok", mediaUrl: "https://rr.example.googlevideo.com/source.mp4" }),
      fetcher: async () => new Response(Buffer.from("oversized"), {
        status: 200,
        headers: { "content-type": "video/mp4", "content-length": "9" },
      }),
    });
    assert.deepEqual(result, {
      status: "fallback",
      reason: "video_exceeds_cache_capacity",
      googleVideoUrl: "https://rr.example.googlevideo.com/source.mp4",
      evictedVideoIds: [],
    });
    assert.deepEqual(await readdir(directory), ["retained.mp4"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persistYouTubeVideo deletes a newly stored file when public byte-range verification fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adhd-video-store-"));
  try {
    const result = await persistYouTubeVideo({ videoId: "unpublished", videoUrl: "https://youtu.be/unpublished" }, {
      directory,
      publicBaseUrl,
      timeoutMs: 1_000,
      minFreeBytes: 0,
      statfs: async () => ({ bavail: 100, bsize: 1 } as never),
      mediaResolver: async () => ({ status: "ok", mediaUrl: "https://rr.example.googlevideo.com/source.mp4" }),
      fetcher: async (input) => String(input).includes("googlevideo.com")
        ? new Response(Buffer.from("video-data"), { status: 200, headers: { "content-type": "video/mp4", "content-length": "10" } })
        : publicResponse(),
    });
    assert.deepEqual(result, {
      status: "fallback",
      reason: "public_range_http_200",
      googleVideoUrl: "https://rr.example.googlevideo.com/source.mp4",
      evictedVideoIds: [],
    });
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persistYouTubeVideo keeps retained files when disk, stream, or public verification fails before capacity eviction", async () => {
  const scenarios: Array<{
    name: string;
    reason: string;
    statfs: () => Promise<{ bavail: number; bsize: number }>;
    source: () => Response;
    publicResponse: (init: RequestInit | undefined) => Response;
  }> = [
    {
      name: "disk",
      reason: "insufficient_disk_space",
      statfs: async () => ({ bavail: 7, bsize: 1 }),
      source: () => new Response(Buffer.from("incoming"), { status: 200, headers: { "content-type": "video/mp4", "content-length": "8" } }),
      publicResponse: (init) => verifiedPublicResponse(init, 8),
    },
    {
      name: "stream",
      reason: "download_error",
      statfs: async () => ({ bavail: 100, bsize: 1 }),
      source: () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial"));
          controller.error(new Error("stream failed"));
        },
      }), { status: 200, headers: { "content-type": "video/mp4", "content-length": "8" } }),
      publicResponse: (init) => verifiedPublicResponse(init, 8),
    },
    {
      name: "public",
      reason: "public_range_http_200",
      statfs: async () => ({ bavail: 100, bsize: 1 }),
      source: () => new Response(Buffer.from("incoming"), { status: 200, headers: { "content-type": "video/mp4", "content-length": "8" } }),
      publicResponse: (init) => init?.method === "HEAD" ? publicResponse() : publicResponse(),
    },
  ];

  for (const scenario of scenarios) {
    const directory = await mkdtemp(join(tmpdir(), `adhd-video-store-${scenario.name}-`));
    try {
      await writeFile(join(directory, "retained.mp4"), "retained");
      const result = await persistYouTubeVideo({ videoId: "incoming", videoUrl: "https://youtu.be/incoming" }, {
        directory,
        publicBaseUrl,
        timeoutMs: 1_000,
        minFreeBytes: 0,
        cacheMaxBytes: 12,
        retentionDays: 30,
        statfs: scenario.statfs,
        mediaResolver: async () => ({ status: "ok", mediaUrl: "https://rr.example.googlevideo.com/source.mp4" }),
        fetcher: async (input, init) => String(input).includes("googlevideo.com") ? scenario.source() : scenario.publicResponse(init),
      });
      assert.deepEqual(result, {
        status: "fallback",
        reason: scenario.reason,
        googleVideoUrl: "https://rr.example.googlevideo.com/source.mp4",
        evictedVideoIds: [],
      });
      assert.deepEqual(await readdir(directory), ["retained.mp4"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("persistYouTubeVideo rejects non-MP4, malformed Range, and mismatched public sizes", async () => {
  const cases: Array<{ name: string; response: Response; reason: string }> = [
    {
      name: "webm",
      response: publicRangeResponse(6, { "content-type": "video/webm" }),
      reason: "invalid_public_content_type",
    },
    {
      name: "missing-content-range",
      response: new Response(Buffer.from("x"), { status: 206, headers: { "content-type": "video/mp4" } }),
      reason: "invalid_public_content_range",
    },
    {
      name: "size-mismatch",
      response: publicRangeResponse(7),
      reason: "public_size_mismatch",
    },
  ];

  for (const item of cases) {
    const directory = await mkdtemp(join(tmpdir(), `adhd-video-store-${item.name}-`));
    try {
      await writeFile(join(directory, "existing.mp4"), "stored");
      const result = await persistYouTubeVideo({ videoId: "existing", videoUrl: "https://youtu.be/existing" }, {
        directory,
        publicBaseUrl,
        timeoutMs: 1_000,
        minFreeBytes: 0,
        mediaResolver: async () => ({ status: "fallback", reason: "unavailable" }),
        fetcher: async (_input, init) => init?.method === "HEAD" ? publicResponse() : item.response,
      });
      assert.deepEqual(result, {
        status: "fallback",
        reason: item.reason,
        evictedVideoIds: [],
      });
      assert.deepEqual(await readdir(directory), ["existing.mp4"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("persistYouTubeVideo restores every retained file and removes the new file when the second eviction staging move fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adhd-video-store-"));
  try {
    const nowMs = Date.UTC(2026, 7, 16);
    await writeFile(join(directory, "oldest.mp4"), "old");
    await writeFile(join(directory, "middle.mp4"), "mid");
    await utimes(join(directory, "oldest.mp4"), new Date(nowMs - 2_000), new Date(nowMs - 2_000));
    await utimes(join(directory, "middle.mp4"), new Date(nowMs - 1_000), new Date(nowMs - 1_000));
    let moveCalls = 0;
    const result = await persistYouTubeVideo({ videoId: "incoming", videoUrl: "https://youtu.be/incoming" }, {
      directory,
      publicBaseUrl,
      timeoutMs: 1_000,
      minFreeBytes: 0,
      cacheMaxBytes: 5,
      retentionDays: 30,
      now: () => nowMs,
      statfs: async () => ({ bavail: 100, bsize: 1 } as never),
      moveFile: async (fromPath, toPath) => {
        moveCalls += 1;
        if (moveCalls === 2) throw new Error("second eviction move failed");
        await rename(fromPath, toPath);
      },
      mediaResolver: async () => ({ status: "ok", mediaUrl: "https://rr.example.googlevideo.com/source.mp4" }),
      fetcher: async (input, init) => String(input).includes("googlevideo.com")
        ? new Response(Buffer.from("data"), { status: 200, headers: { "content-type": "video/mp4", "content-length": "4" } })
        : verifiedPublicResponse(init, 4),
    });

    assert.deepEqual(result, {
      status: "fallback",
      reason: "cache_eviction_error",
      googleVideoUrl: "https://rr.example.googlevideo.com/source.mp4",
      evictedVideoIds: [],
    });
    assert.deepEqual((await readdir(directory)).sort(), ["middle.mp4", "oldest.mp4"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persistYouTubeVideo keeps a verified new file when the second committed staged cleanup removal fails and clears the residue next time", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adhd-video-store-"));
  try {
    const nowMs = Date.UTC(2026, 7, 16);
    await writeFile(join(directory, "oldest.mp4"), "old");
    await writeFile(join(directory, "middle.mp4"), "mid");
    await utimes(join(directory, "oldest.mp4"), new Date(nowMs - 2_000), new Date(nowMs - 2_000));
    await utimes(join(directory, "middle.mp4"), new Date(nowMs - 1_000), new Date(nowMs - 1_000));
    let removeCalls = 0;
    const common = {
      directory,
      publicBaseUrl,
      timeoutMs: 1_000,
      minFreeBytes: 0,
      cacheMaxBytes: 5,
      retentionDays: 30,
      now: () => nowMs,
      statfs: async () => ({ bavail: 100, bsize: 1 } as never),
      mediaResolver: async () => ({ status: "ok" as const, mediaUrl: "https://rr.example.googlevideo.com/source.mp4" }),
      fetcher: async (input: string | URL | Request, init?: RequestInit) => String(input).includes("googlevideo.com")
        ? new Response(Buffer.from("data"), { status: 200, headers: { "content-type": "video/mp4", "content-length": "4" } })
        : verifiedPublicResponse(init, 4),
    };
    const result = await persistYouTubeVideo({ videoId: "incoming", videoUrl: "https://youtu.be/incoming" }, {
      ...common,
      removeFile: async (path) => {
        removeCalls += 1;
        if (removeCalls === 2) throw new Error("second staged cleanup failed");
        await rm(path, { force: true });
      },
    });
    assert.deepEqual(result, {
      status: "cached",
      mediaUrl: "https://media.example/adhd/incoming.mp4",
      evictedVideoIds: ["oldest", "middle"],
    });
    const afterFailure = await readdir(directory);
    assert.equal(afterFailure.includes("incoming.mp4"), true);
    assert.equal(afterFailure.some((name) => name.startsWith(".restore-")), true);
    assert.equal(afterFailure.some((name) => name.startsWith(".eviction-") && name.endsWith(".committed")), true);
    assert.equal(afterFailure.includes("oldest.mp4") || afterFailure.includes("middle.mp4"), false);

    const reused = await persistYouTubeVideo({ videoId: "incoming", videoUrl: "https://youtu.be/incoming" }, common);
    assert.deepEqual(reused, {
      status: "cached",
      mediaUrl: "https://media.example/adhd/incoming.mp4",
      evictedVideoIds: [],
    });
    assert.deepEqual(await readdir(directory), ["incoming.mp4"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persistYouTubeVideo restores an uncommitted staged file on the next cleanup when immediate rollback also fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adhd-video-store-"));
  try {
    const nowMs = Date.UTC(2026, 7, 16);
    await writeFile(join(directory, "oldest.mp4"), "old");
    await writeFile(join(directory, "middle.mp4"), "mid");
    await utimes(join(directory, "oldest.mp4"), new Date(nowMs - 2_000), new Date(nowMs - 2_000));
    await utimes(join(directory, "middle.mp4"), new Date(nowMs - 1_000), new Date(nowMs - 1_000));
    let moveCalls = 0;
    const result = await persistYouTubeVideo({ videoId: "incoming", videoUrl: "https://youtu.be/incoming" }, {
      directory,
      publicBaseUrl,
      timeoutMs: 1_000,
      minFreeBytes: 0,
      cacheMaxBytes: 5,
      retentionDays: 30,
      now: () => nowMs,
      statfs: async () => ({ bavail: 100, bsize: 1 } as never),
      moveFile: async (fromPath, toPath) => {
        moveCalls += 1;
        if (moveCalls === 2 || moveCalls === 3) throw new Error("staging and rollback failed");
        await rename(fromPath, toPath);
      },
      mediaResolver: async () => ({ status: "ok", mediaUrl: "https://rr.example.googlevideo.com/source.mp4" }),
      fetcher: async (input, init) => String(input).includes("googlevideo.com")
        ? new Response(Buffer.from("data"), { status: 200, headers: { "content-type": "video/mp4", "content-length": "4" } })
        : verifiedPublicResponse(init, 4),
    });
    assert.deepEqual(result, {
      status: "fallback",
      reason: "cache_eviction_error",
      googleVideoUrl: "https://rr.example.googlevideo.com/source.mp4",
      evictedVideoIds: [],
    });
    assert.equal((await readdir(directory)).some((name) => name.startsWith(".restore-")), true);
    assert.equal((await readdir(directory)).some((name) => name.startsWith(".eviction-")), false);

    const recovered = await persistYouTubeVideo({ videoId: "middle", videoUrl: "https://youtu.be/middle" }, {
      directory,
      publicBaseUrl,
      timeoutMs: 1_000,
      minFreeBytes: 0,
      cacheMaxBytes: 10,
      retentionDays: 30,
      now: () => nowMs,
      statfs: async () => ({ bavail: 100, bsize: 1 } as never),
      fetcher: async (_input, init) => verifiedPublicResponse(init, 3),
    });
    assert.deepEqual(recovered, {
      status: "cached",
      mediaUrl: "https://media.example/adhd/middle.mp4",
      evictedVideoIds: [],
    });
    assert.deepEqual((await readdir(directory)).sort(), ["middle.mp4", "oldest.mp4"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persistYouTubeVideo rejects a source MIME type that only starts with video/mp4", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adhd-video-store-"));
  try {
    const result = await persistYouTubeVideo({ videoId: "invalid-mime", videoUrl: "https://youtu.be/invalid-mime" }, {
      directory,
      publicBaseUrl,
      timeoutMs: 1_000,
      minFreeBytes: 0,
      statfs: async () => ({ bavail: 100, bsize: 1 } as never),
      mediaResolver: async () => ({ status: "ok", mediaUrl: "https://rr.example.googlevideo.com/source.mp4" }),
      fetcher: async () => new Response(Buffer.from("data"), {
        status: 200,
        headers: { "content-type": "video/mp4-invalid", "content-length": "4" },
      }),
    });
    assert.deepEqual(result, {
      status: "fallback",
      reason: "invalid_source_content_type",
      googleVideoUrl: "https://rr.example.googlevideo.com/source.mp4",
      evictedVideoIds: [],
    });
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cleanupYouTubeVideoCache removes expired and over-capacity videos, stale parts, and committed eviction remnants", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adhd-video-cleanup-"));
  try {
    await writeFile(join(directory, "expired.mp4"), "1234");
    await writeFile(join(directory, "oldest.mp4"), "1234");
    await writeFile(join(directory, "newest.mp4"), "1234");
    await writeFile(join(directory, "stale.mp4.part"), "part");
    await writeFile(join(directory, ".restore-00000000-0000-0000-0000-000000000001-evicted"), "1234");
    await writeFile(join(directory, ".eviction-00000000-0000-0000-0000-000000000001.committed"), "");
    const now = Date.UTC(2026, 7, 16, 0, 0, 0);
    await utimes(join(directory, "expired.mp4"), now / 1000 - 31 * 24 * 60 * 60, now / 1000 - 31 * 24 * 60 * 60);
    await utimes(join(directory, "oldest.mp4"), now / 1000 - 2 * 60 * 60, now / 1000 - 2 * 60 * 60);
    await utimes(join(directory, "newest.mp4"), now / 1000 - 60 * 60, now / 1000 - 60 * 60);
    await utimes(join(directory, "stale.mp4.part"), now / 1000 - 2 * 60 * 60, now / 1000 - 2 * 60 * 60);

    const result = await cleanupYouTubeVideoCache({
      directory,
      cacheMaxBytes: 4,
      retentionDays: 30,
      now: () => now,
    });
    assert.deepEqual(result.evictedVideoIds, ["expired", "oldest"]);
    assert.deepEqual((await readdir(directory)).sort(), ["newest.mp4"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

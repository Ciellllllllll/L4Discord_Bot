import assert from "node:assert/strict";
import {
  YOUTUBE_MEDIA_ATTACHMENT_FILENAME,
  youtubeAttachmentSizeLimitForPremiumTier,
  downloadYouTubeMediaAttachment,
} from "./youtubeMediaAttachment.js";

const mediaUrl = "https://rr.example.googlevideo.com/videoplayback?id=attachment-test";

{
  const result = await downloadYouTubeMediaAttachment(mediaUrl, {
    attachmentSizeLimitBytes: 1_024,
    fetcher: async (url) => {
      assert.equal(url, mediaUrl);
      return new Response(Buffer.from("mp4"), {
        status: 200,
        headers: { "content-type": "video/mp4", "content-length": "3" },
      });
    },
  });
  assert.ok(result);
  assert.equal(result.mediaUrl, `attachment://${YOUTUBE_MEDIA_ATTACHMENT_FILENAME}`);
  assert.equal(result.files.length, 1);
  assert.equal((result.files[0] as { name?: string }).name, YOUTUBE_MEDIA_ATTACHMENT_FILENAME);
}

{
  const result = await downloadYouTubeMediaAttachment(mediaUrl, {
    attachmentSizeLimitBytes: 1_024,
    fetcher: async () => new Response(Buffer.from("mp4"), { status: 200 }),
  });
  assert.ok(result);
  assert.equal(result.mediaUrl, `attachment://${YOUTUBE_MEDIA_ATTACHMENT_FILENAME}`);
}

for (const response of [
  new Response(Buffer.alloc(1_025), {
    status: 200,
    headers: { "content-type": "video/mp4", "content-length": "1025" },
  }),
  new Response(Buffer.from("not video"), {
    status: 200,
    headers: { "content-type": "image/jpeg", "content-length": "9" },
  }),
  new Response("unavailable", { status: 503 }),
]) {
  assert.equal(await downloadYouTubeMediaAttachment(mediaUrl, {
    attachmentSizeLimitBytes: 1_024,
    fetcher: async () => response,
  }), undefined);
}

assert.equal(youtubeAttachmentSizeLimitForPremiumTier(0), 10 * 1024 * 1024);
assert.equal(youtubeAttachmentSizeLimitForPremiumTier(1), 10 * 1024 * 1024);
assert.equal(youtubeAttachmentSizeLimitForPremiumTier(2), 50 * 1000 * 1000);
assert.equal(youtubeAttachmentSizeLimitForPremiumTier(3), 100 * 1000 * 1000);

{
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.of(1, 2));
    },
    cancel() {
      cancelled = true;
    },
  });
  const result = await downloadYouTubeMediaAttachment(mediaUrl, {
    attachmentSizeLimitBytes: 1,
    fetcher: async () => new Response(body, {
      status: 200,
      headers: { "content-type": "video/mp4" },
    }),
  });
  assert.equal(result, undefined);
  assert.equal(cancelled, true);
}

console.log("youtubeMediaAttachment.spec.ts: all assertions passed");

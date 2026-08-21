import { AttachmentBuilder } from "discord.js";
import { readResponseArrayBufferWithLimit } from "../../ai/fetchWithLimits.js";
import { safeYouTubeHttpsUrl } from "./youtubePreviewSource.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_YOUTUBE_MEDIA_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const BOOST_TIER_2_YOUTUBE_MEDIA_ATTACHMENT_MAX_BYTES = 50 * 1000 * 1000;
const BOOST_TIER_3_YOUTUBE_MEDIA_ATTACHMENT_MAX_BYTES = 100 * 1000 * 1000;
export const YOUTUBE_MEDIA_ATTACHMENT_FILENAME = "youtube-preview.mp4";

export function youtubeAttachmentSizeLimitForPremiumTier(premiumTier: number | undefined): number {
  if (premiumTier === 3) return BOOST_TIER_3_YOUTUBE_MEDIA_ATTACHMENT_MAX_BYTES;
  if (premiumTier === 2) return BOOST_TIER_2_YOUTUBE_MEDIA_ATTACHMENT_MAX_BYTES;
  return DEFAULT_YOUTUBE_MEDIA_ATTACHMENT_MAX_BYTES;
}

export type YouTubeMediaAttachmentOptions = {
  attachmentSizeLimitBytes?: number;
  requestTimeoutMs?: number;
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
};

export type YouTubeMediaAttachment = {
  mediaUrl: `attachment://${typeof YOUTUBE_MEDIA_ATTACHMENT_FILENAME}`;
  files: AttachmentBuilder[];
};

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

export async function downloadYouTubeMediaAttachment(
  mediaUrl: string,
  options: YouTubeMediaAttachmentOptions = {},
): Promise<YouTubeMediaAttachment | undefined> {
  const url = safeYouTubeHttpsUrl(mediaUrl);
  if (!url) return undefined;

  const maxBytes = options.attachmentSizeLimitBytes ?? DEFAULT_YOUTUBE_MEDIA_ATTACHMENT_MAX_BYTES;
  try {
    const response = await (options.fetcher ?? fetch)(url, {
      signal: AbortSignal.timeout(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
      headers: { Accept: "video/mp4,video/*;q=0.9,*/*;q=0.1" },
    });
    if (!response.ok) {
      await cancelBody(response);
      return undefined;
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType && !contentType.startsWith("video/")) {
      await cancelBody(response);
      return undefined;
    }
    const contentLength = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      await cancelBody(response);
      return undefined;
    }

    const buffer = Buffer.from(await readResponseArrayBufferWithLimit(response, maxBytes));
    if (buffer.byteLength === 0) return undefined;
    return {
      mediaUrl: `attachment://${YOUTUBE_MEDIA_ATTACHMENT_FILENAME}`,
      files: [new AttachmentBuilder(buffer, { name: YOUTUBE_MEDIA_ATTACHMENT_FILENAME })],
    };
  } catch {
    return undefined;
  }
}

const ALLOWED_IMAGE_TYPES = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
]);

export const MAX_BOKETE_IMAGE_BYTES = 8 * 1024 * 1024;

export type BoketeApiErrorCode =
  | "timeout"
  | "posts_http"
  | "posts_json"
  | "posts_invalid"
  | "image_http"
  | "image_mime"
  | "image_too_large"
  | "image_empty"
  | "network";

export class BoketeApiError extends Error {
  constructor(public readonly code: BoketeApiErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BoketeApiError";
  }
}

export type BoketeFetchResult =
  | { kind: "empty" }
  | { kind: "post"; text: string; image: Buffer; mimeType: string; filename: string };

type BoketePostResponse = {
  text: string;
  image_url: string;
};

export type FetchBoketePostOptions = {
  baseUrl: string;
  requestTimeoutMs: number;
  fetcher?: typeof fetch;
};

function getContentType(response: Response): string {
  return (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

function parsePost(value: unknown): BoketePostResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BoketeApiError("posts_invalid", "Bokete API returned an invalid post.");
  }
  const post = value as Partial<BoketePostResponse>;
  if (typeof post.text !== "string" || !post.text.trim() || typeof post.image_url !== "string" || !post.image_url) {
    throw new BoketeApiError("posts_invalid", "Bokete API post is missing text or image_url.");
  }
  return { text: post.text, image_url: post.image_url };
}

function resolveImageUrl(imagePath: string, baseUrl: string): URL {
  const base = new URL(baseUrl);
  const imageUrl = new URL(imagePath, base);
  if (imageUrl.origin !== base.origin) {
    throw new BoketeApiError("posts_invalid", "Bokete API image URL points outside the configured API origin.");
  }
  return imageUrl;
}

async function readImageWithLimit(response: Response): Promise<Buffer> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BOKETE_IMAGE_BYTES) {
    throw new BoketeApiError("image_too_large", "Bokete image exceeds the attachment limit.");
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const image = Buffer.from(await response.arrayBuffer());
    if (image.byteLength > MAX_BOKETE_IMAGE_BYTES) {
      throw new BoketeApiError("image_too_large", "Bokete image exceeds the attachment limit.");
    }
    return image;
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BOKETE_IMAGE_BYTES) {
      await reader.cancel();
      throw new BoketeApiError("image_too_large", "Bokete image exceeds the attachment limit.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function toBoketeApiError(error: unknown): BoketeApiError {
  if (error instanceof BoketeApiError) return error;
  if (error instanceof Error && error.name === "TimeoutError") {
    return new BoketeApiError("timeout", "Bokete API request timed out.", { cause: error });
  }
  return new BoketeApiError("network", "Bokete API request failed.", { cause: error instanceof Error ? error : undefined });
}

export async function fetchBoketePost(options: FetchBoketePostOptions): Promise<BoketeFetchResult> {
  const fetcher = options.fetcher ?? fetch;
  const signal = AbortSignal.timeout(options.requestTimeoutMs);
  try {
    const postsUrl = new URL("/posts?limit=1", options.baseUrl);
    const postsResponse = await fetcher(postsUrl, { headers: { Accept: "application/json" }, signal });
    if (!postsResponse.ok) {
      throw new BoketeApiError("posts_http", `Bokete posts API returned HTTP ${postsResponse.status}.`);
    }

    let responseBody: unknown;
    try {
      responseBody = await postsResponse.json();
    } catch (error) {
      throw new BoketeApiError("posts_json", "Bokete posts API returned invalid JSON.", { cause: error });
    }
    if (!Array.isArray(responseBody)) {
      throw new BoketeApiError("posts_invalid", "Bokete posts API response is not an array.");
    }
    if (responseBody.length === 0) return { kind: "empty" };

    const post = parsePost(responseBody[0]);
    const imageResponse = await fetcher(resolveImageUrl(post.image_url, options.baseUrl), { signal });
    if (!imageResponse.ok) {
      throw new BoketeApiError("image_http", `Bokete image API returned HTTP ${imageResponse.status}.`);
    }
    const mimeType = getContentType(imageResponse);
    const extension = ALLOWED_IMAGE_TYPES.get(mimeType);
    if (!extension) {
      throw new BoketeApiError("image_mime", `Bokete image API returned unsupported MIME type: ${mimeType || "missing"}.`);
    }
    const image = await readImageWithLimit(imageResponse);
    if (image.byteLength === 0) {
      throw new BoketeApiError("image_empty", "Bokete image is empty.");
    }
    return { kind: "post", text: post.text, image, mimeType, filename: `bokete.${extension}` };
  } catch (error) {
    throw toBoketeApiError(error);
  }
}

import assert from "node:assert/strict";
import { fetchBoketePost, BoketeApiError, MAX_BOKETE_IMAGE_BYTES } from "./boketeClient.js";

const BASE_URL = "https://bokete.example";

function response(body: ConstructorParameters<typeof Response>[0], init: ResponseInit = {}): Response {
  return new Response(body, init);
}

async function expectBoketeError(action: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof BoketeApiError && error.code === code);
}

async function run(): Promise<void> {
  const requestedUrls: string[] = [];
  const result = await fetchBoketePost({
    baseUrl: BASE_URL,
    requestTimeoutMs: 1_000,
    fetcher: async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url === "https://bokete.example/posts?limit=1") {
        return response(JSON.stringify([{ text: "本文", image_url: "/posts/1051/image" }]), {
          headers: { "content-type": "application/json" },
        });
      }
      return response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
    },
  });
  assert.deepEqual(requestedUrls, ["https://bokete.example/posts?limit=1", "https://bokete.example/posts/1051/image"]);
  assert.deepEqual(result, {
    kind: "post",
    text: "本文",
    image: Buffer.from([1, 2, 3]),
    mimeType: "image/png",
    filename: "bokete.png",
  });

  const empty = await fetchBoketePost({
    baseUrl: BASE_URL,
    requestTimeoutMs: 1_000,
    fetcher: async () => response("[]", { headers: { "content-type": "application/json" } }),
  });
  assert.deepEqual(empty, { kind: "empty" });

  await expectBoketeError(
    () => fetchBoketePost({
      baseUrl: BASE_URL,
      requestTimeoutMs: 1_000,
      fetcher: async () => response("unavailable", { status: 503 }),
    }),
    "posts_http",
  );

  await expectBoketeError(
    () => fetchBoketePost({
      baseUrl: BASE_URL,
      requestTimeoutMs: 1_000,
      fetcher: async (input) => String(input).includes("/posts?")
        ? response(JSON.stringify([{ text: "本文", image_url: "/posts/1/image" }]), {
          headers: { "content-type": "application/json" },
        })
        : response("not found", { status: 404 }),
    }),
    "image_http",
  );

  await expectBoketeError(
    () => fetchBoketePost({
      baseUrl: BASE_URL,
      requestTimeoutMs: 1_000,
      fetcher: async (input) => String(input).includes("/posts?")
        ? response(JSON.stringify([{ text: "本文", image_url: "/posts/1/image" }]), { headers: { "content-type": "application/json" } })
        : response("not an image", { headers: { "content-type": "text/plain" } }),
    }),
    "image_mime",
  );

  await expectBoketeError(
    () => fetchBoketePost({
      baseUrl: BASE_URL,
      requestTimeoutMs: 1_000,
      fetcher: async (input) => String(input).includes("/posts?")
        ? response(JSON.stringify([{ text: "本文", image_url: "/posts/1/image" }]), { headers: { "content-type": "application/json" } })
        : response(new Uint8Array([1]), {
          headers: { "content-type": "image/jpeg", "content-length": String(MAX_BOKETE_IMAGE_BYTES + 1) },
        }),
    }),
    "image_too_large",
  );

  await expectBoketeError(
    () => fetchBoketePost({
      baseUrl: BASE_URL,
      requestTimeoutMs: 1_000,
      fetcher: async () => response("not json", { headers: { "content-type": "application/json" } }),
    }),
    "posts_json",
  );

  await expectBoketeError(
    () => fetchBoketePost({
      baseUrl: BASE_URL,
      requestTimeoutMs: 1_000,
      fetcher: async (input) => String(input).includes("/posts?")
        ? response(JSON.stringify([{ text: "本文", image_url: "/posts/1/image" }]), { headers: { "content-type": "application/json" } })
        : response(new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(MAX_BOKETE_IMAGE_BYTES));
            controller.enqueue(new Uint8Array([1]));
            controller.close();
          },
        }), { headers: { "content-type": "image/webp" } }),
    }),
    "image_too_large",
  );

  await expectBoketeError(
    () => fetchBoketePost({
      baseUrl: BASE_URL,
      requestTimeoutMs: 1,
      fetcher: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
    }),
    "timeout",
  );
}

void run()
  .then(() => console.log("boketeClient.spec.ts: all assertions passed"))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

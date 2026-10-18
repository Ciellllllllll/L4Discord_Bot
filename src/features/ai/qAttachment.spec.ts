import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareQAttachment, QAttachmentError, type QAttachment } from "./qAttachment.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jw1sAAAAASUVORK5CYII=", "base64");
const image: QAttachment = { id: "123", name: "image.png", contentType: "image/png", size: png.length, url: "https://cdn.discordapp.com/attachments/1/2/image.png?ex=123&hm=signature" };
const textFile: QAttachment = { ...image, name: "sample.ts", contentType: "text/plain", size: 100 };

void test("uses actual image bytes, not the declared format, and does not follow redirects", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async (url, init) => {
      assert.equal(String(url), image.url);
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal);
      return new Response(png);
    }) as typeof fetch;
    const result = await prepareQAttachment({ ...image, contentType: "image/jpeg" });
    assert.equal(result.kind, "image");
    assert.ok(result.kind === "image" && result.imageDataUrl === `data:image/png;base64,${png.toString("base64")}`);
  } finally { globalThis.fetch = original; }
});

void test("decodes UTF-8 source code without changing its contents", async () => {
  const original = globalThis.fetch;
  const text = 'const message = "こんにちは";\n';
  try {
    globalThis.fetch = (async () => new Response(text)) as typeof fetch;
    assert.deepEqual(await prepareQAttachment(textFile), { kind: "text", name: "sample.ts", text });
  } finally { globalThis.fetch = original; }
});

for (const [name, changes] of [
  ["external URL", { url: "https://example.com/file.png" }],
  ["lookalike CDN", { url: "https://cdn.discordapp.com.example.com/attachments/1/2/file.png" }],
  ["HTTP URL", { url: "http://cdn.discordapp.com/attachments/1/2/file.png" }],
  ["wrong CDN path", { url: "https://cdn.discordapp.com/not-attachments/file.png" }],
  ["URL credentials", { url: "https://private@cdn.discordapp.com/attachments/1/2/file.png" }],
  ["image over size limit", { size: 8 * 1024 * 1024 + 1 }],
  ["PDF", { name: "document.pdf", contentType: "application/pdf" }],
  ["Office", { name: "document.docx", contentType: "application/octet-stream" }],
  ["SVG", { name: "image.svg", contentType: "image/svg+xml" }],
] as const) {
  void test(`rejects ${name} before downloading`, async () => {
    const original = globalThis.fetch;
    let downloads = 0;
    try {
      globalThis.fetch = (async () => { downloads++; throw new Error("must not download"); }) as typeof fetch;
      await assert.rejects(prepareQAttachment({ ...image, ...changes }), QAttachmentError);
      assert.equal(downloads, 0);
    } finally { globalThis.fetch = original; }
  });
}

for (const [name, attachment, response] of [
  ["mislabeled image", image, () => new Response("not an image")],
  ["invalid UTF-8", textFile, () => new Response(Buffer.from([0xc3, 0x28]))],
  ["binary text", textFile, () => new Response(Buffer.from([0, 1, 2, 3]))],
  ["empty text", textFile, () => new Response("  \n")],
  ["too much text", textFile, () => new Response("a".repeat(20_001))],
  ["oversized stream", textFile, () => new Response(Buffer.alloc(1024 * 1024 + 1, 97))],
  ["oversized content length", textFile, () => new Response("small", { headers: { "Content-Length": String(1024 * 1024 + 1) } })],
  ["expired attachment", image, () => new Response("private-error-detail", { status: 404 })],
] as const) {
  void test(`rejects ${name} without exposing upstream details`, async () => {
    const original = globalThis.fetch;
    try {
      globalThis.fetch = (async () => response()) as typeof fetch;
      await assert.rejects(prepareQAttachment(attachment), (error: unknown) => {
        assert.ok(error instanceof QAttachmentError);
        assert.ok(!error.message.includes("private-error-detail"));
        assert.ok(!error.message.includes("signature"));
        return true;
      });
    } finally { globalThis.fetch = original; }
  });
}

void test("reports download failures without sending the signed URL to logs or users", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () => { throw new Error(image.url); }) as typeof fetch;
    await assert.rejects(prepareQAttachment(image), (error: unknown) => error instanceof QAttachmentError && !error.message.includes("hm="));
  } finally { globalThis.fetch = original; }
});

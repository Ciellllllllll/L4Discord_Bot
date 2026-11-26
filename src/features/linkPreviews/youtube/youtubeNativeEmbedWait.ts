import {
  type APIEmbed,
  type Message,
} from "discord.js";
import { parseYouTubeUrl, type YouTubeReplyTarget } from "./youtubePreviewSource.js";

// YouTube のネイティブ埋め込み待機。

const NATIVE_EMBED_WAIT_MS = 3_000;

export function toApiEmbed(value: unknown): APIEmbed | null {
  if (!value || typeof value !== "object") return null;
  const toJSON = (value as { toJSON?: () => unknown }).toJSON;
  const json = typeof toJSON === "function" ? toJSON.call(value) : value;
  return json && typeof json === "object" ? json as APIEmbed : null;
}

function nativeEmbedForTarget(message: Message, target: YouTubeReplyTarget, allowUrlless: boolean): APIEmbed | null {
  for (const raw of message.embeds ?? []) {
    const embed = toApiEmbed(raw);
    if (!embed) continue;
    const parsed = embed.url ? parseYouTubeUrl(embed.url) : null;
    if (parsed?.canonicalUrl === target.canonicalUrl || (allowUrlless && !embed.url && embed.type === "video")) return embed;
  }
  return null;
}

export async function waitForNativeYouTubeEmbed(
  message: Message,
  target: YouTubeReplyTarget,
  allowUrlless: boolean,
  clientOverride?: { on?: (...args: unknown[]) => unknown; off?: (...args: unknown[]) => unknown },
): Promise<APIEmbed | null> {
  const existing = nativeEmbedForTarget(message, target, allowUrlless);
  if (existing) return existing;
  const client = clientOverride ?? (message.client ?? null) as unknown as { on?: (...args: unknown[]) => unknown; off?: (...args: unknown[]) => unknown } | null;
  if (!client?.on || !client.off) return null;
  return await new Promise((resolve) => {
    let done = false;
    const finish = (embed: APIEmbed | null): void => {
      if (done) return; done = true; timeout.removeEventListener("abort", onTimeout); client.off?.("messageUpdate", onUpdate); resolve(embed);
    };
    const onTimeout = (): void => finish(null);
    const onUpdate = (_old: unknown, next: unknown): void => {
      if (!next || typeof next !== "object" || (next as { id?: string }).id !== message.id) return;
      const embed = nativeEmbedForTarget(next as Message, target, allowUrlless);
      if (embed) finish(embed);
    };
    const timeout = AbortSignal.timeout(NATIVE_EMBED_WAIT_MS);
    timeout.addEventListener("abort", onTimeout, { once: true });
    client.on?.("messageUpdate", onUpdate);
  });
}

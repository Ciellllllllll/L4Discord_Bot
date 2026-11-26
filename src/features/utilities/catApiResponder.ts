import type { Message } from "discord.js";
import type { CoreDeps } from "../../core/deps.js";
import { getGuildSettingsData } from "../../core/guildSettings.js";
import { looksLikePrefixCommandLine } from "../../core/commandLike.js";

// CatApiResponder が使う依存。
type CatApiResponderDeps = Pick<CoreDeps, "config" | "db" | "log" | "client">;

const CAT_TRIGGER_PATTERN = /猫|ねこ|neko|neco/i;
const DEFAULT_MIME_TYPES = "jpg,png,gif,mp4";

type CatApiImage = {
  url?: string;
  mime_type?: string;
};

export function containsCatTrigger(content: string): boolean {
  return CAT_TRIGGER_PATTERN.test(String(content || ""));
}

export function buildTheCatApiSearchUrl(baseUrl: string): string {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const url = new URL(`${base}/v1/images/search`);
  url.searchParams.set("limit", "1");
  url.searchParams.set("has_breeds", "0");
  url.searchParams.set("include_breeds", "0");
  url.searchParams.set("include_categories", "0");
  url.searchParams.set("mime_types", DEFAULT_MIME_TYPES);
  return url.toString();
}

function pickCatMediaUrl(items: CatApiImage[]): string | null {
  const first = items.find((item) => typeof item.url === "string" && /^https?:\/\//i.test(item.url));
  return first?.url ?? null;
}

async function fetchCatMediaUrl(ctx: CatApiResponderDeps): Promise<string | null> {
  const apiKey = ctx.config.THECATAPI_API_KEY.trim();
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }

  const response = await fetch(buildTheCatApiSearchUrl(ctx.config.THECATAPI_API_BASE_URL), {
    headers,
    signal: AbortSignal.timeout(ctx.config.THECATAPI_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`TheCatAPI HTTP ${response.status}`);
  }

  const data = await response.json() as unknown;
  if (!Array.isArray(data)) {
    return null;
  }
  return pickCatMediaUrl(data as CatApiImage[]);
}

export class CatApiResponder {
  constructor(private readonly ctx: CatApiResponderDeps) {}

  async onMessage(message: Message): Promise<void> {
    if (!this.ctx.config.THECATAPI_ENABLED) {
      return;
    }
    if (message.author?.bot) {
      return;
    }
    if (!message.guild || message.guild.id !== this.ctx.config.GUILD_ID) {
      return;
    }
    if (looksLikePrefixCommandLine(message.content)) {
      return;
    }
    const settings = await getGuildSettingsData(this.ctx.db, message.guild.id);
    if (settings.auto_reply_excluded_channel_ids?.includes(message.channelId)) {
      return;
    }

    const content = String(message.content || "");
    if (!containsCatTrigger(content)) {
      return;
    }

    try {
      const mediaUrl = await fetchCatMediaUrl(this.ctx);
      if (!mediaUrl) {
        return;
      }
      await message.reply({
        content: mediaUrl,
        allowedMentions: { parse: [], repliedUser: false },
      });
    } catch (err) {
      this.ctx.log.warn({ err: String(err) }, "CatApiResponder reply failed");
    }
  }
}

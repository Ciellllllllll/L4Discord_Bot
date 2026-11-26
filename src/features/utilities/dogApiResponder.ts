import type { Message } from "discord.js";
import type { CoreDeps } from "../../core/deps.js";
import { getGuildSettingsData } from "../../core/guildSettings.js";
import { looksLikePrefixCommandLine } from "../../core/commandLike.js";

// DogApiResponder が使う依存。
type DogApiResponderDeps = Pick<CoreDeps, "config" | "db" | "log" | "client">;

const DOG_TRIGGER_PATTERN = /犬|いぬ|inu|dog/i;

type DogApiRandomImageResponse = {
  message?: string;
  status?: string;
};

export function containsDogTrigger(content: string): boolean {
  return DOG_TRIGGER_PATTERN.test(String(content || ""));
}

export function isValidDogApiImageResponse(data: unknown): data is Required<DogApiRandomImageResponse> {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return false;
  }
  const response = data as DogApiRandomImageResponse;
  return response.status === "success" && typeof response.message === "string" && /^https?:\/\//i.test(response.message);
}

async function fetchDogImageUrl(ctx: DogApiResponderDeps): Promise<string | null> {
  const response = await fetch(ctx.config.DOGCEO_IMAGE_RANDOM_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(ctx.config.DOGCEO_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Dog CEO API HTTP ${response.status}`);
  }

  const data = await response.json() as unknown;
  if (!isValidDogApiImageResponse(data)) {
    return null;
  }
  return data.message;
}

export class DogApiResponder {
  constructor(private readonly ctx: DogApiResponderDeps) {}

  async onMessage(message: Message): Promise<void> {
    if (!this.ctx.config.DOGCEO_ENABLED) {
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
    if (!containsDogTrigger(content)) {
      return;
    }

    try {
      const imageUrl = await fetchDogImageUrl(this.ctx);
      if (!imageUrl) {
        return;
      }
      await message.reply({
        content: imageUrl,
        allowedMentions: { parse: [], repliedUser: false },
      });
    } catch (err) {
      this.ctx.log.warn({ err: String(err) }, "DogApiResponder reply failed");
    }
  }
}

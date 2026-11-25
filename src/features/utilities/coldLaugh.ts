import fs from "node:fs";
import path from "node:path";
import type { Message } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { getGuildSettingsData } from "../../core/guildSettings.js";
import { looksLikePrefixCommandLine } from "../../message/commandLike.js";

export const COLD_LAUGH_KEYWORD =
  "うお,うおｗ,uo,おお,oo,どわー,ったく,かっこよw,えぐー！笑,えぐー！w,えぐー!笑,えぐー!w,冗談ですやん,きちー,おもろいなあ！,おもろいなあ!,ど、どした？,ど、どした?,ちょw,落ち着けw,落ち着け,ええて,必死やんw,すごいなあキミw,すごいなあw,すごいなあキミｗ,すごいなあｗ,怒んなやw,怒んなやｗ,";

const LINK_IN_CONTENT_PATTERN =
  /(?:https?:\/\/|www\.)[^\s<>\u3000]+|(?:discord\.gg|discord(?:app)?\.com\/channels|x\.com|twitter\.com|mobile\.twitter\.com|vxtwitter\.com|fxtwitter\.com|fixupx\.com|youtube\.com|m\.youtube\.com|music\.youtube\.com|youtu\.be)\/[^\s<>\u3000]+/gi;
const BARE_URL_BOUNDARY_CHARS = new Set(["<", "(", "[", "{", "\"", "'"]);

function hasUrlCandidateBoundary(content: string, index: number, urlText: string): boolean {
  if (/^https?:\/\//i.test(urlText) || index <= 0) return true;
  const previous = content[index - 1] ?? "";
  return /\s/u.test(previous) || previous === "\u3000" || BARE_URL_BOUNDARY_CHARS.has(previous);
}

function countKeywordOccurrences(text: string, keyword: string): number {
  return text ? String(text).split(keyword).length - 1 : 0;
}

export function totalColdLaughHits(content: string): number {
  return COLD_LAUGH_KEYWORD.split(",")
    .map((phrase) => phrase.trim())
    .filter(Boolean)
    .reduce((total, phrase) => total + countKeywordOccurrences(content, phrase), 0);
}

export function stripLinksForColdLaughContent(content: string): string {
  const text = String(content || "");
  return text.replace(LINK_IN_CONTENT_PATTERN, (match, offset: number) => (
    hasUrlCandidateBoundary(text, offset, match) ? " " : match
  ));
}

export function coldLaughHitsForMessageContent(content: string): number {
  return totalColdLaughHits(stripLinksForColdLaughContent(content));
}

let storeLock = Promise.resolve();

async function withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = storeLock;
  let release!: () => void;
  storeLock = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

export class ColdLaughHandler {
  private readonly storePath: string;
  private readonly countsReady: Promise<void>;
  private coldLaughCounts: Record<string, number> = {};

  constructor(private readonly ctx: BotContext) {
    this.storePath = path.resolve(ctx.config.COLD_LAUGH_STORE_PATH);
    this.countsReady = this.loadCounts();
  }

  private async loadCounts(): Promise<void> {
    await withStoreLock(async () => {
      try {
        if (!fs.existsSync(this.storePath)) {
          this.coldLaughCounts = {};
          return;
        }
        const parsed = JSON.parse(fs.readFileSync(this.storePath, "utf8") || "{}") as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          this.coldLaughCounts = {};
          return;
        }
        this.coldLaughCounts = Object.fromEntries(
          Object.entries(parsed).filter((entry): entry is [string, number] => Number.isInteger(entry[1])),
        );
      } catch (err) {
        this.ctx.log.error({ err: String(err) }, "cold_laugh_counts load error");
        this.coldLaughCounts = {};
      }
    });
  }

  private async saveCounts(): Promise<void> {
    await withStoreLock(async () => {
      try {
        fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
        const temporaryPath = `${this.storePath}.tmp`;
        fs.writeFileSync(temporaryPath, JSON.stringify(this.coldLaughCounts, null, 2), "utf8");
        fs.renameSync(temporaryPath, this.storePath);
      } catch (err) {
        this.ctx.log.warn({ err: String(err) }, "cold_laugh_counts save error");
      }
    });
  }

  async onMessage(message: Message): Promise<void> {
    if (message.author?.bot || !message.guild || message.guild.id !== this.ctx.config.GUILD_ID) return;
    if (looksLikePrefixCommandLine(message.content)) return;
    const settings = await getGuildSettingsData(this.ctx.db, message.guild.id);
    if (settings.auto_reply_excluded_channel_ids?.includes(message.channelId)) return;

    const coldCount = coldLaughHitsForMessageContent(String(message.content || ""));
    if (coldCount === 0) return;

    await this.countsReady;
    const userId = String(message.author.id);
    await withStoreLock(async () => {
      this.coldLaughCounts[userId] = Number(this.coldLaughCounts[userId] || 0) + coldCount;
    });
    await this.saveCounts();

    try {
      await message.reply({
        content: `冷笑を検知しました！あなたの現在の冷笑回数は ${this.coldLaughCounts[userId]} 回です。`,
        allowedMentions: { repliedUser: true, parse: [] },
      });
    } catch (err) {
      this.ctx.log.warn({ err: String(err) }, "cold_laugh reply error");
    }
  }
}

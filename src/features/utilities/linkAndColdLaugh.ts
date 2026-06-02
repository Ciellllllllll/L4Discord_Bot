import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import type { Message } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { getGuildSettingsData } from "../../core/guildSettings.js";
import { looksLikePrefixCommandLine } from "../../message/commandLike.js";
import { COLD_LAUGH_KEYWORD } from "./coldLaughConstants.js";

const VX_DOMAIN = "vxtwitter.com";
const X_DOMAINS = new Set(["x.com", "twitter.com", "mobile.twitter.com"]);

const URL_CANDIDATE_PATTERN =
  /(?<url>(?:https?:\/\/)?(?:www\.)?(?:x\.com|twitter\.com|mobile\.twitter\.com)\/[^\s<>\u3000]+)/gi;
const LINK_IN_CONTENT_PATTERN =
  /(?:https?:\/\/|www\.)[^\s<>\u3000]+|(?:discord\.gg|discord(?:app)?\.com\/channels|x\.com|twitter\.com|mobile\.twitter\.com)\/[^\s<>\u3000]+/gi;
const TRIM_TAIL_CHARS = ".,!?;:)]}>,、。」』）";

function stripUrlTail(urlText: string): string {
  let u = String(urlText || "").trim();
  while (u && TRIM_TAIL_CHARS.includes(u[u.length - 1]!)) {
    u = u.slice(0, -1);
  }
  return u;
}

function ensureScheme(urlText: string): string {
  const u = String(urlText || "").trim();
  if (/^https?:\/\//i.test(u)) {
    return u;
  }
  return `https://${u}`;
}

function hostWithoutWww(host: string): string {
  const h = String(host || "").trim().toLowerCase();
  return h.startsWith("www.") ? h.slice(4) : h;
}

function isXLikeUrl(urlText: string): boolean {
  try {
    const parsed = new URL(ensureScheme(urlText));
    const host = hostWithoutWww(parsed.host);
    return X_DOMAINS.has(host);
  } catch {
    return false;
  }
}

function toVxTwitterUrl(urlText: string): string | null {
  try {
    const parsed = new URL(ensureScheme(urlText));
    const host = hostWithoutWww(parsed.host);
    if (!host || host === VX_DOMAIN || !X_DOMAINS.has(host)) {
      return null;
    }
    parsed.host = VX_DOMAIN;
    return parsed.toString();
  } catch {
    return null;
  }
}

function countKeywordOccurrences(text: string, keyword: string): number {
  if (!text) {
    return 0;
  }
  return String(text).split(keyword).length - 1;
}

// v2 と同じ split 挙動だが、カンマ区切り各フレーズを個別に数える（元の巨大1文字列検索は実質無効のため）

export function totalColdLaughHits(content: string): number {
  const phrases = COLD_LAUGH_KEYWORD.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  let n = 0;
  for (const p of phrases) {
    n += countKeywordOccurrences(content, p);
  }
  return n;
}

export function stripLinksForColdLaughContent(content: string): string {
  return String(content || "").replace(LINK_IN_CONTENT_PATTERN, " ");
}

export function coldLaughHitsForMessageContent(content: string): number {
  return totalColdLaughHits(stripLinksForColdLaughContent(content));
}

function extractXLinks(content: string): string[] {
  const found: string[] = [];
  for (const match of String(content || "").matchAll(URL_CANDIDATE_PATTERN)) {
    const raw = match.groups?.url ?? "";
    const trimmed = stripUrlTail(raw);
    if (trimmed && isXLikeUrl(trimmed)) {
      found.push(trimmed);
    }
  }
  return found;
}

let lock = Promise.resolve();

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = lock;
  let release!: () => void;
  lock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

export class LinkAndColdLaugh {
  private readonly storePath: string;
  private coldLaughCounts: Record<string, number> = {};

  constructor(private readonly ctx: BotContext) {
    this.storePath = path.resolve(this.ctx.config.COLD_LAUGH_STORE_PATH);
    void this.loadCounts();
  }

  private async loadCounts(): Promise<void> {
    await withLock(async () => {
      try {
        if (!fs.existsSync(this.storePath)) {
          this.coldLaughCounts = {};
          return;
        }
        const raw = fs.readFileSync(this.storePath, "utf8");
        const parsed = JSON.parse(raw || "{}") as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const clean: Record<string, number> = {};
          for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof k === "string" && Number.isInteger(v)) {
              clean[k] = v as number;
            }
          }
          this.coldLaughCounts = clean;
        } else {
          this.coldLaughCounts = {};
        }
      } catch (err) {
        this.ctx.log.error({ err: String(err) }, "cold_laugh_counts load error");
        this.coldLaughCounts = {};
      }
    });
  }

  private async saveCounts(): Promise<void> {
    await withLock(async () => {
      try {
        fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
        const tmp = `${this.storePath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(this.coldLaughCounts, null, 2), "utf8");
        fs.renameSync(tmp, this.storePath);
      } catch (err) {
        this.ctx.log.warn({ err: String(err) }, "cold_laugh_counts save error");
      }
    });
  }

  async onMessage(message: Message): Promise<void> {
    if (message.author?.bot || !message.guild) {
      return;
    }
    if (message.guild.id !== this.ctx.config.GUILD_ID) {
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

    const coldCount = coldLaughHitsForMessageContent(content);
    if (coldCount > 0) {
      const userId = String(message.author.id);
      await withLock(async () => {
        const current = Number(this.coldLaughCounts[userId] || 0);
        this.coldLaughCounts[userId] = current + coldCount;
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

    const xLinks = extractXLinks(content);
    if (xLinks.length === 0) {
      return;
    }

    const converted: string[] = [];
    const seen = new Set<string>();
    for (const link of xLinks) {
      const v = toVxTwitterUrl(link);
      if (v && !seen.has(v)) {
        seen.add(v);
        converted.push(v);
      }
    }

    if (converted.length === 0) {
      return;
    }

    try {
      await message.suppressEmbeds(true);
    } catch {}

    try {
      await message.reply({
        content: converted.join("\n"),
        allowedMentions: { parse: [], repliedUser: false },
      });
    } catch (err) {
      this.ctx.log.warn({ err: String(err) }, "vxtwitter reply error");
    }
  }
}

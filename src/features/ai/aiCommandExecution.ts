import { ComponentCardBuilder } from "../../core/componentCard.js";
import {
  type Guild,
  type GuildMember,
  type TextBasedChannel,
} from "discord.js";
import type { CoreDeps } from "../../core/deps.js";
import type { IVcRankingRepository, VcRankPeriod } from "../../adapters/legacyDb/vcRankingRepository.js";
import { vcCreatorErrText, type VcTemporaryChannelManager } from "../vc/vcTemporaryChannelManager.js";

const ALLOWED_ACTIONS = new Set(["create_vc", "vc_ranking"]);
const CREATE_VC_GENRES = new Set(["雑談", "ゲーム", "作業"]);
const VC_RANKING_PERIODS = new Set(["daily", "weekly", "monthly", "yearly"]);

const RATE_WINDOW_MS = 60 * 1000;
const rateBuckets = new Map<string, number[]>();

function rateLimitKey(userId: string, guildId: string): string {
  return `${userId}:${guildId}`;
}

function takeRateSlot(key: string, maxPerWindow: number): boolean {
  const now = Date.now();
  let arr = rateBuckets.get(key);
  if (!arr) {
    arr = [];
    rateBuckets.set(key, arr);
  }
  const filtered = arr.filter((t) => now - t < RATE_WINDOW_MS);
  if (filtered.length >= maxPerWindow) {
    return false;
  }
  filtered.push(now);
  rateBuckets.set(key, filtered);
  return true;
}

function validateCreateVcArgs(args: Record<string, unknown>): { ok: true; genre: string; name: string } | { ok: false; userMessage: string } {
  const genre = args.genre;
  const name = args.name;
  if (typeof genre !== "string" || !CREATE_VC_GENRES.has(genre)) {
    return { ok: false, userMessage: "ジャンルは「雑談」「ゲーム」「作業」のいずれかにしてください。" };
  }
  if (typeof name !== "string") {
    return { ok: false, userMessage: "VC名が不正です。" };
  }
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 30) {
    return { ok: false, userMessage: "VC名は2〜30文字で指定してください。" };
  }
  return { ok: true, genre, name: trimmed };
}

function judgePeriodToRepo(period: string): VcRankPeriod {
  const map: Record<string, VcRankPeriod> = {
    daily: "day",
    weekly: "week",
    monthly: "month",
    yearly: "all",
  };
  return map[period] ?? "all";
}

function validateVcRankingArgs(args: Record<string, unknown>): { ok: true; period: string } | { ok: false; userMessage: string } {
  let period: unknown = args.period;
  if (period === undefined || period === null || period === "") {
    period = "yearly";
  }
  if (typeof period !== "string" || !VC_RANKING_PERIODS.has(period)) {
    return {
      ok: false,
      userMessage: "ランキング期間は daily / weekly / monthly / yearly のいずれかで指定してください（未指定時は年次）。",
    };
  }
  return { ok: true, period };
}

export type AiCommandExecResult = {
  ok: boolean;
  userMessage: string;
  cards?: ComponentCardBuilder[];
};

// AI コマンド実行が使う依存。aiRouter は使わない。
type AiCommandExecutionDeps =
  & Pick<CoreDeps, "config" | "log">
  & { vcTemp: VcTemporaryChannelManager; vcRanking: IVcRankingRepository };

export async function runAiSlashCommand(ctx: AiCommandExecutionDeps, params: {
  guild: Guild | null;
  channel: TextBasedChannel;
  member: GuildMember | null;
  userId: string;
  action: string;
  args: Record<string, unknown>;
}): Promise<AiCommandExecResult> {
  const { guild, member, userId, action, args } = params;

  if (!ctx.config.AI_COMMAND_EXECUTION_ENABLED) {
    return { ok: false, userMessage: "チャットからの機能実行は現在無効です。" };
  }

  if (!guild || !userId) {
    return { ok: false, userMessage: "この操作はサーバー内でのみ利用できます。" };
  }

  if (!ALLOWED_ACTIONS.has(action)) {
    return { ok: false, userMessage: "この操作はチャットからは実行できません。" };
  }

  let createNorm: { genre: string; name: string } | null = null;
  let rankingNorm: { period: string } | null = null;

  if (action === "create_vc") {
    const v = validateCreateVcArgs(args);
    if (!v.ok) return { ok: false, userMessage: v.userMessage };
    createNorm = { genre: v.genre, name: v.name };
  } else if (action === "vc_ranking") {
    const v = validateVcRankingArgs(args);
    if (!v.ok) return { ok: false, userMessage: v.userMessage };
    rankingNorm = { period: v.period };
  }

  const limit = Math.max(1, ctx.config.AI_ACTION_RATE_LIMIT);
  const key = rateLimitKey(userId, guild.id);
  if (!takeRateSlot(key, limit)) {
    return { ok: false, userMessage: "操作が続いています。しばらく待ってから再試行してください。" };
  }

  const userTag = member?.user?.username ?? String(userId);

  try {
    if (action === "create_vc" && createNorm) {
      const out = await ctx.vcTemp.createTemporaryVc(guild, {
        name: createNorm.name,
        creatorUserId: userId,
        creatorTag: userTag,
      });
      if (out.ok) {
        return {
          ok: true,
          userMessage: `ボイスチャンネル「${out.name}」を作成しました。 <#${out.channelId}>`,
        };
      }
      return { ok: false, userMessage: vcCreatorErrText[out.error] };
    }

    if (action === "vc_ranking" && rankingNorm) {
      const repoPeriod = judgePeriodToRepo(rankingNorm.period);
      const rows = await ctx.vcRanking.getRanking(guild.id, repoPeriod);
      if (rows.length === 0) {
        return {
          ok: true,
          userMessage:
            "VCランキングデータがありません。累計を見る場合は期間を yearly にするか、記録開始後の daily/weekly/monthly を試してください。",
        };
      }
      const lines = rows.slice(0, 20).map((r, i) => `${i + 1}. <@${r.userId}> — ${r.seconds}s`);
      const embed = new ComponentCardBuilder()
        .setTitle("VC 滞在ランキング")
        .setDescription(lines.join("\n").slice(0, 4000))
      return {
        ok: true,
        userMessage: "ランキングを表示しました。",
        cards: [embed],
      };
    }

    return { ok: false, userMessage: "この操作はチャットからは実行できません。" };
  } catch (err) {
    ctx.log.warn({ err: String(err), action, userId, guildId: guild.id }, "ai command execution threw");
    return { ok: false, userMessage: "処理中にエラーが発生しました。" };
  }
}

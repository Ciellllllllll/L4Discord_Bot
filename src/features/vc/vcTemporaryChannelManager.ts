import {
  ChannelType,
  type CategoryChannel,
  type Client,
  type Guild,
  type VoiceBasedChannel,
  type VoiceChannel,
  type VoiceState,
} from "discord.js";
import type { AppConfig } from "../../core/config.js";
import {
  DISCORD_API_MISSING_ACCESS,
  DISCORD_API_MISSING_PERMISSIONS,
  getDiscordErrorCode,
  getHttpStatus,
  isDiscordUnknownChannel,
  isDiscordUnknownChannelOrNotFound,
} from "../../core/discordErrors.js";
import type pino from "pino";
import { setTimeout as delay } from "node:timers/promises";
import type { VcTempPersistence } from "./vcTempPersistence.js";

const GRACE_NO_JOIN_MS = 24 * 60 * 60 * 1000;
const EMPTY_DELETE_DEBOUNCE_MS = 1000;
const MAX_ACCESS_DENIED_FAILURES = 10;
const ACCESS_DENIED_BACKOFF_SWEEP_INTERVAL = 10;

type ActiveVcMeta = {
  guildId: string;
  createdAtMs: number;
  userEverJoined: boolean;
};

function getSortedVoiceChannels(guild: Guild): VoiceChannel[] {
  return [...guild.channels.cache.values()]
    .filter((c): c is VoiceChannel => c.type === ChannelType.GuildVoice)
    .sort((a, b) => a.rawPosition - b.rawPosition);
}

function resolveDefaultVoiceCategory(guild: Guild): CategoryChannel | null {
  for (const vc of getSortedVoiceChannels(guild)) {
    const pid = vc.parentId;
    if (!pid) continue;
    const p = guild.channels.cache.get(pid);
    if (p?.type === ChannelType.GuildCategory) {
      return p as CategoryChannel;
    }
  }
  return null;
}

function resolveConfiguredVoiceCategory(guild: Guild, categoryIdRaw: string | undefined): CategoryChannel | null {
  const categoryId = String(categoryIdRaw ?? "").trim();
  if (!categoryId) return null;
  const category = guild.channels.cache.get(categoryId) ?? null;
  if (!category || category.type !== ChannelType.GuildCategory) return null;
  return category as CategoryChannel;
}

export const vcCreatorErrText = {
  no_voice_category:
    "サーバーにボイスチャンネルがありません。先に通常のボイスチャンネルを1つ以上作成してからお試しください。",
  invalid_name_length: "VC名は2〜30文字で入力してください。",
  api_error: "VCの作成に失敗しました。しばらくしてからもう一度お試しください。",
} as const;

export type VcCreatorErrorKey = keyof typeof vcCreatorErrText;

export const vcRenameErrText = {
  not_temporary_vc: "現在接続中のVCは変更対象ではありません。",
  invalid_name_length: "変更後VC名は2〜30文字で入力してください。",
  api_error: "VC名の変更に失敗しました。しばらくしてからもう一度お試しください。",
} as const;

export type VcRenameErrorKey = keyof typeof vcRenameErrText;

function fetchErrorDedupKey(err: unknown): string {
  const code = getDiscordErrorCode(err);
  if (code !== null) return `code:${code}`;
  const status = getHttpStatus(err);
  if (status !== null) return `status:${status}`;
  if (err instanceof Error) return `err:${err.name}:${err.message}`;
  return `err:${String(err)}`;
}

function isAccessDeniedError(err: unknown): boolean {
  const code = getDiscordErrorCode(err);
  if (code === DISCORD_API_MISSING_ACCESS || code === DISCORD_API_MISSING_PERMISSIONS) {
    return true;
  }
  return getHttpStatus(err) === 403;
}

export class VcTemporaryChannelManager {
  private readonly activeVcs = new Map<string, ActiveVcMeta>();
  private readonly lastFetchErrorKeyByChannel = new Map<string, string>();
  private readonly accessDeniedCountByChannel = new Map<string, number>();
  private readonly accessDeniedBackoffRemainingSweeps = new Map<string, number>();
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly log: pino.Logger,
    private readonly client: Client,
    private readonly config: AppConfig,
    private readonly persistence: VcTempPersistence,
  ) {}

  startSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      void this.sweepTask();
    }, 30_000);
  }

  stopSweep(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  isTrackedTemporaryVc(channelId: string): boolean {
    return this.activeVcs.has(channelId);
  }

  onVoiceStateUpdate(before: VoiceState, after: VoiceState): void {
    const joinedId = after.channelId;
    if (joinedId && joinedId !== before.channelId && this.activeVcs.has(joinedId)) {
      const meta = this.activeVcs.get(joinedId);
      if (meta && !meta.userEverJoined) {
        meta.userEverJoined = true;
        void this.persistence.setUserEverJoined(joinedId).catch((err) => this.log.warn({ err, channelId: joinedId }, "temporary VC join state persist failed"));
      }
    }

    const leftId = before.channelId;
    if (leftId && leftId !== after.channelId && this.activeVcs.has(leftId)) {
      void this.maybeDeleteEmptyVcById(leftId);
    }
  }

  async restoreFromDatabase(expectedGuildId: string): Promise<void> {
    const rows = await this.persistence.listTracked();
    for (const row of rows) {
      if (row.guildId !== expectedGuildId) {
        this.removeTracking(row.channelId);
        continue;
      }
      if (this.isGuildMissingFromCache(row.guildId)) {
        this.removeTracking(row.channelId);
        this.log.info(
          { channelId: row.channelId, guildId: row.guildId, context: "restoreFromDatabase" },
          "temporary VC guild not in cache; removed tracking",
        );
        continue;
      }
      this.activeVcs.set(row.channelId, {
        guildId: row.guildId,
        createdAtMs: row.createdAtMs,
        userEverJoined: row.userEverJoined,
      });
      const fetched = await this.fetchTrackedVoiceChannel(row.channelId, "restoreFromDatabase");
      if (fetched.status === "missing") {
        this.removeTracking(row.channelId);
        continue;
      }
      if (fetched.status !== "ok") {
        continue;
      }
      if (fetched.channel.members.size === 0) {
        void this.maybeDeleteEmptyVc(fetched.channel);
      }
    }
  }

  private async fetchTrackedVoiceChannel(
    channelId: string,
    context: string,
    options: { countAccessDenied?: boolean } = {},
  ): Promise<
    | { status: "ok"; channel: VoiceChannel }
    | { status: "missing" }
    | { status: "error"; err: unknown }
  > {
    const cached = this.client.channels.cache.get(channelId);
    if (cached) {
      this.lastFetchErrorKeyByChannel.delete(channelId);
      this.accessDeniedCountByChannel.delete(channelId);
      this.accessDeniedBackoffRemainingSweeps.delete(channelId);
      if (cached.type !== ChannelType.GuildVoice) {
        return { status: "missing" };
      }
      return { status: "ok", channel: cached };
    }
    try {
      const fetched = await this.client.channels.fetch(channelId);
      this.lastFetchErrorKeyByChannel.delete(channelId);
      this.accessDeniedCountByChannel.delete(channelId);
      this.accessDeniedBackoffRemainingSweeps.delete(channelId);
      if (!fetched || fetched.type !== ChannelType.GuildVoice) {
        return { status: "missing" };
      }
      return { status: "ok", channel: fetched };
    } catch (err) {
      if (isDiscordUnknownChannelOrNotFound(err)) {
        this.lastFetchErrorKeyByChannel.delete(channelId);
        this.accessDeniedCountByChannel.delete(channelId);
        this.accessDeniedBackoffRemainingSweeps.delete(channelId);
        return { status: "missing" };
      }
      if (options.countAccessDenied) {
        if (isAccessDeniedError(err)) {
          const failures = (this.accessDeniedCountByChannel.get(channelId) ?? 0) + 1;
          this.accessDeniedCountByChannel.set(channelId, failures);
          if (failures >= MAX_ACCESS_DENIED_FAILURES) {
            // 追跡と DB 行は維持したまま確認間隔を長くする（以後は 10 回の sweep に 1 回だけ fetch する）
            this.accessDeniedBackoffRemainingSweeps.set(channelId, ACCESS_DENIED_BACKOFF_SWEEP_INTERVAL - 1);
            if (failures === MAX_ACCESS_DENIED_FAILURES) {
              this.lastFetchErrorKeyByChannel.set(channelId, fetchErrorDedupKey(err));
              this.log.warn(
                {
                  err,
                  channelId,
                  context,
                  consecutiveFailures: failures,
                  sweepInterval: ACCESS_DENIED_BACKOFF_SWEEP_INTERVAL,
                },
                "temporary VC fetch access denied repeatedly; reducing sweep frequency",
              );
              return { status: "error", err };
            }
          }
        } else {
          // 5xx・429・ネットワーク等、アクセス拒否以外の失敗を挟んだ場合は連続カウンタと間隔延長をリセットする
          this.accessDeniedCountByChannel.delete(channelId);
          this.accessDeniedBackoffRemainingSweeps.delete(channelId);
        }
      }
      const errKey = fetchErrorDedupKey(err);
      if (this.lastFetchErrorKeyByChannel.get(channelId) === errKey) {
        this.log.debug?.({ err, channelId, context }, "temporary VC fetch failed; keeping tracking");
      } else {
        this.lastFetchErrorKeyByChannel.set(channelId, errKey);
        this.log.warn({ err, channelId, context }, "temporary VC fetch failed; keeping tracking");
      }
      return { status: "error", err };
    }
  }

  private isGuildMissingFromCache(guildId: string): boolean {
    if (typeof this.client.isReady !== "function" || !this.client.isReady()) {
      return false;
    }
    const guildsCache = this.client.guilds?.cache;
    if (!guildsCache) {
      return false;
    }
    return !guildsCache.has(guildId);
  }

  private removeTracking(channelId: string): void {
    this.activeVcs.delete(channelId);
    this.lastFetchErrorKeyByChannel.delete(channelId);
    this.accessDeniedCountByChannel.delete(channelId);
    this.accessDeniedBackoffRemainingSweeps.delete(channelId);
    void this.persistence.deleteTracked(channelId).catch((err) => this.log.warn({ err, channelId }, "temporary VC tracking delete failed"));
  }

  private async maybeDeleteEmptyVcById(channelId: string): Promise<void> {
    if (!this.activeVcs.has(channelId)) return;
    const fetched = await this.fetchTrackedVoiceChannel(channelId, "maybeDeleteEmptyVcById");
    if (fetched.status === "missing") {
      this.removeTracking(channelId);
      return;
    }
    if (fetched.status !== "ok") {
      return;
    }
    await this.maybeDeleteEmptyVc(fetched.channel);
  }

  private async sweepTask(): Promise<void> {
    for (const [channelId, meta] of [...this.activeVcs.entries()]) {
      if (this.isGuildMissingFromCache(meta.guildId)) {
        this.removeTracking(channelId);
        this.log.info(
          { channelId, guildId: meta.guildId, context: "sweepTask" },
          "temporary VC guild not in cache; removed tracking",
        );
        continue;
      }
      const remaining = this.accessDeniedBackoffRemainingSweeps.get(channelId) ?? 0;
      if (remaining > 0) {
        this.accessDeniedBackoffRemainingSweeps.set(channelId, remaining - 1);
        continue;
      }
      const fetched = await this.fetchTrackedVoiceChannel(channelId, "sweepTask", { countAccessDenied: true });
      if (fetched.status === "missing") {
        this.removeTracking(channelId);
        continue;
      }
      if (fetched.status === "error") {
        continue;
      }
      if (fetched.channel.members.size === 0) await this.maybeDeleteEmptyVc(fetched.channel);
    }
  }

  private async maybeDeleteEmptyVc(channel: VoiceBasedChannel): Promise<void> {
    if (!this.activeVcs.has(channel.id)) return;
    const meta = this.activeVcs.get(channel.id);
    if (!meta) return;

    const firstCheck = await this.fetchTrackedVoiceChannel(channel.id, "maybeDeleteEmptyVc:beforeDebounce");
    if (firstCheck.status === "missing") {
      this.removeTracking(channel.id);
      return;
    }
    if (firstCheck.status !== "ok") {
      return;
    }
    if (firstCheck.channel.members.size > 0) return;
    if (!meta.userEverJoined && Date.now() - meta.createdAtMs < GRACE_NO_JOIN_MS) return;

    await delay(EMPTY_DELETE_DEBOUNCE_MS);

    const secondCheck = await this.fetchTrackedVoiceChannel(channel.id, "maybeDeleteEmptyVc:afterDebounce");
    if (secondCheck.status === "missing") {
      this.removeTracking(channel.id);
      return;
    }
    if (secondCheck.status !== "ok") {
      return;
    }
    const fresh = secondCheck.channel;
    if (fresh.members.size > 0) return;

    try {
      const name = fresh.name;
      await fresh.delete("一時VC 空室のため自動削除");
      this.removeTracking(fresh.id);
      this.log.info({ channelId: fresh.id, name }, "temporary VC deleted (empty)");
    } catch (err) {
      if (isDiscordUnknownChannel(err)) {
        this.removeTracking(channel.id);
        this.log.info({ channelId: channel.id }, "temporary VC already gone; cleared tracking");
      } else {
        this.log.warn({ err, channelId: channel.id }, "temporary VC delete failed");
      }
    }
  }

  async createTemporaryVc(
    guild: Guild,
    opts: { name: string; creatorUserId: string; creatorTag: string },
  ): Promise<
    | { ok: true; channelId: string; name: string }
    | { ok: false; error: VcCreatorErrorKey }
  > {
    const voices = getSortedVoiceChannels(guild);
    if (voices.length === 0) return { ok: false, error: "no_voice_category" };

    const category =
      resolveConfiguredVoiceCategory(guild, this.config.VC_CREATE_CATEGORY_ID) ?? resolveDefaultVoiceCategory(guild);

    const vcName = String(opts.name || "").trim();
    if (vcName.length < 2 || vcName.length > 30) return { ok: false, error: "invalid_name_length" };

    try {
      const vc = await guild.channels.create({
        name: vcName,
        type: ChannelType.GuildVoice,
        ...(category ? { parent: category } : {}),
        reason: `一時VC 作成者: ${opts.creatorTag || opts.creatorUserId}`,
      });

      const createdAtMs = Date.now();
      this.activeVcs.set(vc.id, {
        guildId: guild.id,
        createdAtMs,
        userEverJoined: false,
      });
      try {
        await this.persistence.insertTracked({
          channelId: vc.id,
          guildId: guild.id,
          createdAtMs,
          userEverJoined: false,
        });
      } catch (err) {
        this.activeVcs.delete(vc.id);
        await vc.delete("一時VC 追跡保存失敗のため補償削除").catch((deleteErr) => {
          this.log.error({ err: deleteErr, channelId: vc.id }, "temporary VC compensation delete failed");
        });
        await this.persistence.deleteTracked(vc.id).catch((deleteErr) => {
          this.log.error({ err: deleteErr, channelId: vc.id }, "temporary VC compensation tracking delete failed");
        });
        this.log.warn({ err, channelId: vc.id }, "temporary VC tracking persist failed; compensated created channel");
        return { ok: false, error: "api_error" };
      }

      return { ok: true, channelId: vc.id, name: vcName };
    } catch (err) {
      this.log.warn({ err }, "createTemporaryVc API error");
      return { ok: false, error: "api_error" };
    }
  }

  async renameTemporaryVc(
    channelId: string,
    opts: { name: string; actorUserId: string; actorTag: string },
  ): Promise<
    | { ok: true; channelId: string; name: string }
    | { ok: false; error: VcRenameErrorKey }
  > {
    if (!this.activeVcs.has(channelId)) {
      return { ok: false, error: "not_temporary_vc" };
    }

    const vcName = String(opts.name || "").trim();
    if (vcName.length < 2 || vcName.length > 30) {
      return { ok: false, error: "invalid_name_length" };
    }

    const fetched = await this.fetchTrackedVoiceChannel(channelId, "renameTemporaryVc");
    if (fetched.status === "missing") {
      this.removeTracking(channelId);
      return { ok: false, error: "not_temporary_vc" };
    }
    if (fetched.status !== "ok") {
      return { ok: false, error: "api_error" };
    }
    const ch = fetched.channel;

    try {
      await ch.setName(vcName, `一時VC 名称変更者: ${opts.actorTag || opts.actorUserId}`);
      return { ok: true, channelId: ch.id, name: vcName };
    } catch (err) {
      this.log.warn({ err, channelId, vcName }, "renameTemporaryVc API error");
      return { ok: false, error: "api_error" };
    }
  }
}

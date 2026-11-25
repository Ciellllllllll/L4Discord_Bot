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
import { isDiscordUnknownChannel } from "../../core/discordErrors.js";
import type pino from "pino";
import { setTimeout as delay } from "node:timers/promises";
import type { VcTempPersistence } from "./vcTempPersistence.js";

const GRACE_NO_JOIN_MS = 24 * 60 * 60 * 1000;
const EMPTY_DELETE_DEBOUNCE_MS = 1000;

type ActiveVcMeta = {
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

export class VcTemporaryChannelManager {
  private readonly activeVcs = new Map<string, ActiveVcMeta>();
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
      this.activeVcs.set(row.channelId, {
        createdAtMs: row.createdAtMs,
        userEverJoined: row.userEverJoined,
      });
      const ch =
        (this.client.channels.cache.get(row.channelId) as VoiceBasedChannel | undefined) ??
        ((await this.client.channels.fetch(row.channelId).catch(() => null)) as VoiceBasedChannel | null);
      if (!ch || ch.type !== ChannelType.GuildVoice) {
        this.removeTracking(row.channelId);
        continue;
      }
      if (ch.members.size === 0) {
        void this.maybeDeleteEmptyVc(ch);
      }
    }
  }

  private removeTracking(channelId: string): void {
    this.activeVcs.delete(channelId);
    void this.persistence.deleteTracked(channelId).catch((err) => this.log.warn({ err, channelId }, "temporary VC tracking delete failed"));
  }

  private async maybeDeleteEmptyVcById(channelId: string): Promise<void> {
    if (!this.activeVcs.has(channelId)) return;
    const ch =
      (this.client.channels.cache.get(channelId) as VoiceBasedChannel | undefined) ??
      ((await this.client.channels.fetch(channelId).catch(() => null)) as VoiceBasedChannel | null);
    if (!ch || ch.type !== ChannelType.GuildVoice) {
      this.removeTracking(channelId);
      return;
    }
    await this.maybeDeleteEmptyVc(ch);
  }

  private async sweepTask(): Promise<void> {
    for (const channelId of [...this.activeVcs.keys()]) {
      const ch =
        this.client.channels.cache.get(channelId) ??
        (await this.client.channels.fetch(channelId).catch(() => null));
      if (!ch || ch.type !== ChannelType.GuildVoice) {
        this.removeTracking(channelId);
        continue;
      }
      if (ch.members.size === 0) await this.maybeDeleteEmptyVc(ch);
    }
  }

  private async maybeDeleteEmptyVc(channel: VoiceBasedChannel): Promise<void> {
    if (!this.activeVcs.has(channel.id)) return;
    const meta = this.activeVcs.get(channel.id);
    if (!meta) return;

    let fresh =
      (this.client.channels.cache.get(channel.id) as VoiceBasedChannel | undefined) ??
      ((await this.client.channels.fetch(channel.id).catch(() => null)) as VoiceBasedChannel | null);
    if (!fresh || fresh.type !== ChannelType.GuildVoice) {
      this.removeTracking(channel.id);
      return;
    }
    if (fresh.members.size > 0) return;
    if (!meta.userEverJoined && Date.now() - meta.createdAtMs < GRACE_NO_JOIN_MS) return;

    await delay(EMPTY_DELETE_DEBOUNCE_MS);

    fresh =
      (this.client.channels.cache.get(channel.id) as VoiceBasedChannel | undefined) ??
      ((await this.client.channels.fetch(channel.id).catch(() => null)) as VoiceBasedChannel | null);
    if (!fresh || fresh.type !== ChannelType.GuildVoice) {
      this.removeTracking(channel.id);
      return;
    }
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

    const ch =
      (this.client.channels.cache.get(channelId) as VoiceBasedChannel | undefined) ??
      ((await this.client.channels.fetch(channelId).catch(() => null)) as VoiceBasedChannel | null);
    if (!ch || ch.type !== ChannelType.GuildVoice) {
      this.removeTracking(channelId);
      return { ok: false, error: "not_temporary_vc" };
    }

    try {
      await ch.setName(vcName, `一時VC 名称変更者: ${opts.actorTag || opts.actorUserId}`);
      return { ok: true, channelId: ch.id, name: vcName };
    } catch (err) {
      this.log.warn({ err, channelId, vcName }, "renameTemporaryVc API error");
      return { ok: false, error: "api_error" };
    }
  }
}

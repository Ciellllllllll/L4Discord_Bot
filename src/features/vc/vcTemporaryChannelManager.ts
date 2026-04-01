import {
  ActionRowBuilder,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type CategoryChannel,
  type Client,
  type Guild,
  type Message,
  type VoiceBasedChannel,
  type VoiceChannel,
  type VoiceState,
} from "discord.js";
import type { BotContext } from "../../bot/context.js";
import type { AppConfig } from "../../core/config.js";
import { getPermanentUiVersion } from "../../core/releaseVersions.js";
import type pino from "pino";
import { PANEL_KIND_VC_CREATOR } from "../panels/constants.js";
import { tryDeleteBotPanelMessage } from "../panels/panelDiscordOps.js";
import { ensurePanelMessageRow, savePanelMessageRow } from "../panels/panelMessageStore.js";
import {
  buildVcCreatorMainEmbed,
  buildVcCreatorMainRows,
  VC_NAME_MODAL_PREFIX,
} from "./vcCreatorUi.js";

const GRACE_NO_JOIN_MS = 24 * 60 * 60 * 1000;
const EMPTY_DELETE_DEBOUNCE_MS = 1000;

type ActiveVcMeta = {
  creatorUserId: string;
  createdAtMs: number;
  userEverJoined: boolean;
};

/** サーバー上のボイスチャンネルを表示順で列挙 */
function getSortedVoiceChannels(guild: Guild): VoiceChannel[] {
  return [...guild.channels.cache.values()]
    .filter((c): c is VoiceChannel => c.type === ChannelType.GuildVoice)
    .sort((a, b) => a.rawPosition - b.rawPosition);
}

/**
 * 既存の通常ボイスチャンネルが属するカテゴリを1つ選ぶ（先頭のカテゴリ付きVCの親）。
 * カテゴリなしのVCのみの場合は null（作成時は親なしで同列に置く）。
 */
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

export const vcCreatorErrText = {
  no_voice_category:
    "サーバーにボイスチャンネルがありません。先に通常のボイスチャンネルを1つ以上作成してからお試しください。",
  invalid_name_length: "VC名は2〜30文字で入力してください。",
  api_error: "VCの作成に失敗しました。しばらくしてからもう一度お試しください。",
} as const;

export type VcCreatorErrorKey = keyof typeof vcCreatorErrText;

export class VcTemporaryChannelManager {
  private readonly activeVcs = new Map<string, ActiveVcMeta>();
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly log: pino.Logger,
    private readonly client: Client,
    private readonly config: AppConfig,
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

  onVoiceStateUpdate(before: VoiceState, after: VoiceState): void {
    const joinedId = after.channelId;
    if (joinedId && joinedId !== before.channelId && this.activeVcs.has(joinedId)) {
      const meta = this.activeVcs.get(joinedId);
      if (meta && !meta.userEverJoined) meta.userEverJoined = true;
    }

    const leftChannel = before.channel;
    if (leftChannel && this.activeVcs.has(leftChannel.id)) {
      void this.maybeDeleteEmptyVc(leftChannel);
    }
  }

  private async sweepTask(): Promise<void> {
    for (const channelId of [...this.activeVcs.keys()]) {
      const ch =
        this.client.channels.cache.get(channelId) ??
        (await this.client.channels.fetch(channelId).catch(() => null));
      if (!ch || ch.type !== ChannelType.GuildVoice) {
        this.activeVcs.delete(channelId);
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
      this.activeVcs.delete(channel.id);
      return;
    }
    if (fresh.members.size > 0) return;
    if (!meta.userEverJoined && Date.now() - meta.createdAtMs < GRACE_NO_JOIN_MS) return;

    await new Promise((r) => setTimeout(r, EMPTY_DELETE_DEBOUNCE_MS));

    fresh =
      (this.client.channels.cache.get(channel.id) as VoiceBasedChannel | undefined) ??
      ((await this.client.channels.fetch(channel.id).catch(() => null)) as VoiceBasedChannel | null);
    if (!fresh || fresh.type !== ChannelType.GuildVoice) {
      this.activeVcs.delete(channel.id);
      return;
    }
    if (fresh.members.size > 0) return;

    const creatorId = meta.creatorUserId;
    this.activeVcs.delete(channel.id);

    try {
      const name = fresh.name;
      await fresh.delete("一時VC 空室のため自動削除");
      this.log.info({ channelId: fresh.id, name }, "temporary VC deleted (empty)");

      const ownerId = this.config.OWNER_ID.trim();
      if (/^\d+$/.test(ownerId)) {
        const owner = await this.client.users.fetch(ownerId).catch(() => null);
        if (owner) {
          const creatorMention = creatorId ? `<@${creatorId}>` : "不明ユーザー";
          await owner
            .send(`ユーザー ${creatorMention} が作成した VC ${name} は空室のため削除されました`)
            .catch(() => undefined);
        }
      }
    } catch (err) {
      this.log.warn({ err, channelId: channel.id }, "temporary VC delete failed");
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

    const category = resolveDefaultVoiceCategory(guild);

    const vcName = String(opts.name || "").trim();
    if (vcName.length < 2 || vcName.length > 30) return { ok: false, error: "invalid_name_length" };

    try {
      const vc = await guild.channels.create({
        name: vcName,
        type: ChannelType.GuildVoice,
        ...(category ? { parent: category } : {}),
        reason: `一時VC 作成者: ${opts.creatorTag || opts.creatorUserId}`,
      });

      this.activeVcs.set(vc.id, {
        creatorUserId: opts.creatorUserId,
        createdAtMs: Date.now(),
        userEverJoined: false,
      });

      const ownerId = this.config.OWNER_ID.trim();
      if (/^\d+$/.test(ownerId)) {
        const owner = await this.client.users.fetch(ownerId).catch(() => null);
        if (owner) {
          await owner
            .send(`ユーザー <@${opts.creatorUserId}> が VC ${vcName} を作成しました`)
            .catch(() => undefined);
        }
      }

      return { ok: true, channelId: vc.id, name: vcName };
    } catch (err) {
      this.log.warn({ err }, "createTemporaryVc API error");
      return { ok: false, error: "api_error" };
    }
  }
}

export function buildVcNameModal(genre: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${VC_NAME_MODAL_PREFIX}${genre}`)
    .setTitle("VC名の入力")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("vc_name_input")
          .setLabel("VCの名前 2から30文字")
          .setPlaceholder("例: 雑談VC")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(2)
          .setMaxLength(30),
      ),
    );
}

/** メッセージが当 Bot の VC 作成パネルか（再接続スキャン用） */
export function vcPanelMessageHasOpenButton(message: Message<boolean>): boolean {
  for (const row of message.components) {
    if (!("components" in row) || !row.components) continue;
    for (const c of row.components) {
      if ("customId" in c && c.customId === "open_vc_modal") return true;
    }
  }
  return false;
}

export async function reconcileVcCreatorPanel(ctx: BotContext, guild: Guild, channelId: string): Promise<void> {
  const kind = PANEL_KIND_VC_CREATOR;
  const codeVer = getPermanentUiVersion(kind);
  let row = await ensurePanelMessageRow(ctx, guild.id, kind, channelId);

  if (row.channel_id !== channelId) {
    if (row.message_id) {
      await tryDeleteBotPanelMessage(ctx, guild, row.channel_id, row.message_id);
    }
    await savePanelMessageRow(ctx, row.id, channelId, "", { ...row.data, status: "pending" });
    row = { ...row, channel_id: channelId, message_id: "", data: { ...row.data, status: "pending" } };
  }

  const ch = await guild.channels.fetch(channelId).catch(() => null);
  if (!ch?.isTextBased()) {
    ctx.log.warn({ channelId }, "USER panel channel missing or not text (VC creator panel)");
    await savePanelMessageRow(ctx, row.id, channelId, row.message_id, {
      ...row.data,
      status: "error",
      last_error: "channel_missing",
    });
    return;
  }

  const embed = buildVcCreatorMainEmbed();
  const components = buildVcCreatorMainRows();
  const botId = ctx.client.user?.id ?? "";

  if (row.message_id) {
    const msg = await ch.messages.fetch(row.message_id).catch(() => null);
    if (msg && msg.author?.id === botId && vcPanelMessageHasOpenButton(msg)) {
      if (row.data.ui_version === codeVer) {
        return;
      }
      try {
        await msg.edit({ embeds: [embed], components });
        await savePanelMessageRow(ctx, row.id, channelId, msg.id, {
          ui_version: codeVer,
          status: "sent",
          last_sent_at: new Date().toISOString(),
        });
      } catch (e) {
        ctx.log.error({ err: e, kind }, "VC creator panel edit failed");
      }
      return;
    }
  }

  const recent = await ch.messages.fetch({ limit: 50 }).catch(() => null);
  if (recent && botId) {
    const existing = recent.find((m) => m.author?.id === botId && vcPanelMessageHasOpenButton(m));
    if (existing) {
      try {
        if (row.data.ui_version !== codeVer) {
          await existing.edit({ embeds: [embed], components });
        }
        await savePanelMessageRow(ctx, row.id, channelId, existing.id, {
          ui_version: codeVer,
          status: "sent",
          last_sent_at: new Date().toISOString(),
        });
      } catch (e) {
        ctx.log.error({ err: e }, "VC creator panel reconnect edit failed");
      }
      ctx.log.info({ messageId: existing.id }, "VC creator UI reconnected via scan");
      return;
    }
  }

  try {
    const sent = await ch.send({ embeds: [embed], components });
    await savePanelMessageRow(ctx, row.id, channelId, sent.id, {
      ui_version: codeVer,
      status: "sent",
      last_sent_at: new Date().toISOString(),
    });
    ctx.log.info({ messageId: sent.id }, "VC creator UI sent");
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    await savePanelMessageRow(ctx, row.id, channelId, row.message_id, {
      ...row.data,
      status: "error",
      last_error: err.slice(0, 500),
    });
    ctx.log.error({ err: e }, "VC creator UI send failed");
  }
}

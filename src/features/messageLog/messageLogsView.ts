import {
  AttachmentBuilder,
  MessageFlags,
  type ButtonInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { componentCardsPayload, ephemeralComponentPayload } from "../../core/componentCard.js";
import { isAdmin } from "../../core/permission.js";
import { TtlStore } from "../../core/ttlStore.js";
import {
  buildDetailImageSlotsPostgres,
  lookupStoredAttachmentsMapPostgres,
  type StoredAttachmentRow,
} from "./messageAttachmentArchive.js";
import { parseSearchFilterInputs, snowflakeFromDb, type SearchSession } from "./messageLogFilters.js";
import {
  buildExportTextPostgres,
  exportMessageLogsPostgres,
  fetchLogByIdPostgres,
  fetchLogsForExportPostgres,
  searchMessageLogsPostgres,
} from "./messageLogRepository.js";
import {
  buildDetailPayload,
  buildListCardsPayload,
  buildSearchModal,
  MESSAGE_LOG_DETAIL_PREFIX,
  MESSAGE_LOG_LIST_PREFIX,
  MESSAGE_LOG_MODAL_PREFIX,
} from "./messageLogRenderer.js";

export const PANEL_BUTTON_ID = "message_logs_open";
export type { SearchSession };
export { exportMessageLogsPostgres, searchMessageLogsPostgres };

const MAX_EXPORT_ROWS = 5000;
const SESSION_TTL_MS = 30 * 60 * 1000;
const searchSessions = new TtlStore<SearchSession>(SESSION_TTL_MS);

function canUseLogUi(interaction: { guildId: string | null; member: unknown }, ctx: BotContext): boolean {
  const member = interaction.member && typeof interaction.member === "object" && "roles" in interaction.member
    ? interaction.member
    : null;
  if (!interaction.guildId || interaction.guildId !== ctx.config.GUILD_ID) return false;
  return isAdmin(member as never, ctx.config);
}

async function requireSession(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  ctx: BotContext,
  sessionId: string,
): Promise<SearchSession | null> {
  const session = searchSessions.get(String(sessionId || "").trim());
  if (!session) {
    await interaction.reply({
      content: "検索セッションの期限が切れました。もう一度検索を開始してください。",
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }
  if (interaction.user.id !== session.ownerId) {
    await interaction.reply({ content: "この検索UIは作成者のみ操作できます。", flags: MessageFlags.Ephemeral });
    return null;
  }
  if (interaction.guildId !== session.guildId) {
    await interaction.reply({ content: "このサーバーでは利用できない検索セッションです。", flags: MessageFlags.Ephemeral });
    return null;
  }
  if (!canUseLogUi(interaction, ctx)) {
    await interaction.reply({ content: "ログ閲覧の権限がありません。", flags: MessageFlags.Ephemeral });
    return null;
  }
  session.lastTouchedAt = Date.now();
  searchSessions.touch(session.id);
  return session;
}

export async function routeMessageLogButton(interaction: ButtonInteraction, ctx: BotContext): Promise<boolean> {
  searchSessions.sweep();
  const id = interaction.customId;

  if (id === PANEL_BUTTON_ID) {
    if (!interaction.guildId || interaction.guildId !== ctx.config.GUILD_ID) {
      await interaction.reply({ content: "このサーバーでは利用できません。", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (!canUseLogUi(interaction, ctx)) {
      await interaction.reply({ content: "ログ閲覧の権限がありません。", flags: MessageFlags.Ephemeral });
      return true;
    }
    await interaction.showModal(buildSearchModal(null));
    return true;
  }

  if (id.startsWith(MESSAGE_LOG_LIST_PREFIX)) {
    const parts = id.split(":");
    if (parts.length < 4) return false;
    const session = await requireSession(interaction, ctx, parts[2]!);
    if (!session) return true;
    const action = parts[3]!;

    if (action === "modal") {
      await interaction.showModal(buildSearchModal(session));
      return true;
    }
    if (action === "export") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const { total, rows } = await fetchLogsForExportPostgres(
          ctx.messageLogPgPool,
          session,
          ctx.client.user?.id ?? "",
          MAX_EXPORT_ROWS,
        );
        if (rows.length === 0) {
          await interaction.editReply({ content: "エクスポート対象のログがありません。" });
          return true;
        }
        const content = await buildExportTextPostgres(ctx.messageAttachmentPgPool, session, rows, total);
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const file = new AttachmentBuilder(Buffer.from(content, "utf8"), {
          name: `message_logs_${session.guildId}_${stamp}.txt`,
        });
        const suffix = total > rows.length ? `（${rows.length}/${total}件を出力）` : "";
        await interaction.editReply({ content: `テキスト出力が完了しました。${suffix}`, files: [file] });
      } catch {
        await interaction.editReply({ content: "ログのエクスポートに失敗しました。" }).catch(() => undefined);
      }
      return true;
    }

    if (action === "prev") session.page = Math.max(0, session.page - 1);
    else if (action === "next") session.page += 1;
    else if (action === "toggle_attach") {
      session.attachmentsOnly = !session.attachmentsOnly;
      session.page = 0;
    } else if (action !== "refresh") return true;

    const { total, totalPages, rows } = await searchMessageLogsPostgres(
      ctx.messageLogPgPool,
      session,
      ctx.client.user?.id ?? "",
    );
    const payload = buildListCardsPayload(session, rows, total, totalPages);
    await interaction.update(payload).catch(async () => {
      await interaction.reply({ content: "検索UIの更新に失敗しました。", flags: MessageFlags.Ephemeral }).catch(() => undefined);
    });
    return true;
  }

  if (id.startsWith(MESSAGE_LOG_DETAIL_PREFIX)) {
    const parts = id.split(":");
    if (parts.length < 7) return false;
    const session = await requireSession(interaction, ctx, parts[2]!);
    if (!session) return true;
    const logId = Number(parts[3]);
    const idxPart = Number(parts[4]);
    const part5 = parts[5] ?? "";
    const action = parts[6] ?? "";
    if (!Number.isFinite(logId)) return true;

    let imageIndex = 0;
    if (action === "open") {
      if (part5 !== "img" && part5 !== "0") return false;
      imageIndex = 0;
    } else if (part5 === "img" && action === "prev") {
      if (!Number.isFinite(idxPart)) return false;
      imageIndex = Math.max(0, idxPart - 1);
    } else if (part5 === "img" && action === "next") {
      if (!Number.isFinite(idxPart)) return false;
      imageIndex = idxPart + 1;
    } else {
      return false;
    }

    const row = await fetchLogByIdPostgres(ctx.messageLogPgPool, session.guildId, logId);
    const gid = snowflakeFromDb(row?.guild_id);
    const mid = snowflakeFromDb(row?.message_id);
    const slots = await buildDetailImageSlotsPostgres(ctx.messageAttachmentPgPool, gid, mid);
    const map = ctx.messageAttachmentPgPool
      ? await lookupStoredAttachmentsMapPostgres(ctx.messageAttachmentPgPool, gid, mid)
      : new Map<string, StoredAttachmentRow>();
    const payload = buildDetailPayload(session, logId, imageIndex, row, slots, map);

    try {
      await interaction.update({
        ...componentCardsPayload(payload.cards, payload.components),
        files: payload.files,
      });
      if (payload.ephemeralFollowUpCard) {
        await interaction.followUp({
          ...componentCardsPayload([payload.ephemeralFollowUpCard]),
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
      }
    } catch {
      await interaction.reply({ content: "詳細の表示に失敗しました。", flags: MessageFlags.Ephemeral }).catch(() => undefined);
    }
    return true;
  }

  return false;
}

export async function routeMessageLogModal(interaction: ModalSubmitInteraction, ctx: BotContext): Promise<boolean> {
  if (!interaction.customId.startsWith(MESSAGE_LOG_MODAL_PREFIX)) return false;
  searchSessions.sweep();

  if (!interaction.guildId || interaction.guildId !== ctx.config.GUILD_ID) {
    await interaction.reply({ content: "このサーバーでは利用できません。", flags: MessageFlags.Ephemeral });
    return true;
  }
  if (!canUseLogUi(interaction, ctx)) {
    await interaction.reply({ content: "ログ閲覧の権限がありません。", flags: MessageFlags.Ephemeral });
    return true;
  }

  const sessionToken = interaction.customId.split(":")[2] || "new";
  let existing: SearchSession | null = null;
  if (sessionToken !== "new") {
    existing = searchSessions.get(sessionToken);
    if (existing && existing.ownerId !== interaction.user.id) {
      await interaction.reply({ content: "この検索セッションは作成者のみ更新できます。", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (existing && existing.guildId !== interaction.guildId) existing = null;
  }

  const parsed = parseSearchFilterInputs({
    keyword: interaction.fields.getTextInputValue("ml_keyword"),
    user: interaction.fields.getTextInputValue("ml_user"),
    channel: interaction.fields.getTextInputValue("ml_channel"),
    from: interaction.fields.getTextInputValue("ml_from"),
    to: interaction.fields.getTextInputValue("ml_to"),
  });
  if (!parsed.ok) {
    await interaction.reply({ content: parsed.error, flags: MessageFlags.Ephemeral });
    return true;
  }

  const now = Date.now();
  const session: SearchSession = existing ?? {
    id: searchSessions.generateId(8),
    ownerId: interaction.user.id,
    guildId: interaction.guildId,
    keyword: "",
    userId: null,
    channelId: null,
    fromIso: null,
    toIso: null,
    attachmentsOnly: false,
    page: 0,
    createdAt: now,
    lastTouchedAt: now,
  };
  Object.assign(session, parsed.filters, { page: 0, lastTouchedAt: now });
  if (!existing) session.attachmentsOnly = false;
  searchSessions.set(session.id, session);

  const { total, totalPages, rows } = await searchMessageLogsPostgres(
    ctx.messageLogPgPool,
    session,
    ctx.client.user?.id ?? "",
  );
  await interaction.reply(ephemeralComponentPayload(buildListCardsPayload(session, rows, total, totalPages)));
  return true;
}

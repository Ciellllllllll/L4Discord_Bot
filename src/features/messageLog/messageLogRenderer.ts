import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { ComponentCardBuilder, componentCardsPayload } from "../../core/componentCard.js";
import { normalizeSnowflake } from "../../core/snowflake.js";
import {
  formatStoredHint,
  type DetailImageSlotsResult,
  type StoredAttachmentRow,
} from "./messageAttachmentArchive.js";
import {
  buildDiscordMessageUrl,
  describeLogType,
  formatDateForInput,
  formatDiscordDate,
  resolveAttachmentCount,
  resolveFieldTitleSuffix,
  resolvePrimaryTimestamp,
  resolveSenderLine,
  shortenText,
  snowflakeFromDb,
  splitLongText,
  type LogRow,
  type SearchSession,
} from "./messageLogFilters.js";
import { MESSAGE_LOG_RESULTS_PER_PAGE } from "./messageLogRepository.js";

export const MESSAGE_LOG_MODAL_PREFIX = "ml:modal:";
export const MESSAGE_LOG_LIST_PREFIX = "ml:list:";
export const MESSAGE_LOG_DETAIL_PREFIX = "ml:detail:";

const MAX_CONTENT_PREVIEW = 120;
const CONTENT_CHUNK = 3500;
const MAX_CONTENT_EMBEDS = 5;

export function buildSearchModal(existing: SearchSession | null): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`${MESSAGE_LOG_MODAL_PREFIX}${existing?.id ?? "new"}`)
    .setTitle("メッセージログ検索条件");

  const keywordInput = new TextInputBuilder()
    .setCustomId("ml_keyword")
    .setLabel("キーワード (任意)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder("本文に含まれる語句");

  const userInput = new TextInputBuilder()
    .setCustomId("ml_user")
    .setLabel("ユーザーID/メンション (任意)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder("123… または <@…>");

  const channelInput = new TextInputBuilder()
    .setCustomId("ml_channel")
    .setLabel("チャンネルID/メンション (任意)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder("123… または <#…>");

  const fromInput = new TextInputBuilder()
    .setCustomId("ml_from")
    .setLabel("開始日時 (任意)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder("例: 2026-03-16 00:00");

  const toInput = new TextInputBuilder()
    .setCustomId("ml_to")
    .setLabel("終了日時 (任意)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder("例: 2026-03-16 23:59");

  if (existing) {
    if (existing.keyword) keywordInput.setValue(existing.keyword.slice(0, 100));
    if (existing.userId) userInput.setValue(existing.userId);
    if (existing.channelId) channelInput.setValue(existing.channelId);
    if (existing.fromIso) fromInput.setValue(formatDateForInput(existing.fromIso));
    if (existing.toIso) toInput.setValue(formatDateForInput(existing.toIso));
  }

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(keywordInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(userInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(channelInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(fromInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(toInput),
  );
  return modal;
}

function buildFiltersSummary(session: SearchSession): string {
  return [
    `キーワード: ${session.keyword || "指定なし"}`,
    `ユーザー: ${session.userId ? `<@${session.userId}>` : "指定なし"}`,
    `チャンネル: ${session.channelId ? `<#${session.channelId}>` : "指定なし"}`,
    `期間: ${session.fromIso ? formatDiscordDate(session.fromIso) : "指定なし"} 〜 ${session.toIso ? formatDiscordDate(session.toIso) : "指定なし"}`,
    `添付ありのみ: ${session.attachmentsOnly ? "有効" : "無効"}`,
  ].join("\n");
}

function buildListCard(session: SearchSession, rows: LogRow[], total: number, totalPages: number): ComponentCardBuilder {
  const card = new ComponentCardBuilder()
    .setTitle("メッセージログ検索結果")
    .setDescription(buildFiltersSummary(session))
    .setFooter({ text: `ページ ${session.page + 1}/${totalPages} | 全 ${total} 件` });

  if (rows.length === 0) {
    card.addFields({ name: "結果", value: "該当するログはありません。" });
    return card;
  }

  rows.forEach((row, index) => {
    const absolute = session.page * MESSAGE_LOG_RESULTS_PER_PAGE + index + 1;
    const channelId = snowflakeFromDb(row.channel_id);
    const primary = resolvePrimaryTimestamp(row);
    const preview = shortenText(row.content ?? "", MAX_CONTENT_PREVIEW) || "(本文なし)";
    const count = resolveAttachmentCount(row);
    const channelLabel = channelId ? `<#${channelId}>` : `ID:${snowflakeFromDb(row.channel_id) || "-"}`;
    card.addFields({
      name: `${absolute}. ${resolveFieldTitleSuffix(row)}`,
      value: [
        `送信者: ${resolveSenderLine(row)}`,
        `チャンネル: ${channelLabel}`,
        `${primary.label}: ${formatDiscordDate(primary.iso)}`,
        `種別: ${describeLogType(row.log_type)}`,
        `本文先頭: ${preview}`,
        `添付件数: ${count}`,
      ].join("\n"),
    });
  });
  return card;
}

function buildListComponents(session: SearchSession, rows: LogRow[], total: number, totalPages: number) {
  const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${MESSAGE_LOG_LIST_PREFIX}${session.id}:prev`)
      .setLabel("前へ")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(total === 0 || session.page <= 0),
    new ButtonBuilder()
      .setCustomId(`${MESSAGE_LOG_LIST_PREFIX}${session.id}:next`)
      .setLabel("次へ")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(total === 0 || session.page + 1 >= totalPages),
    new ButtonBuilder()
      .setCustomId(`${MESSAGE_LOG_LIST_PREFIX}${session.id}:toggle_attach`)
      .setLabel(`添付ありのみ: ${session.attachmentsOnly ? "有効" : "無効"}`)
      .setStyle(session.attachmentsOnly ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${MESSAGE_LOG_LIST_PREFIX}${session.id}:modal`)
      .setLabel("条件を再入力")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${MESSAGE_LOG_LIST_PREFIX}${session.id}:export`)
      .setLabel("テキスト出力")
      .setStyle(ButtonStyle.Secondary),
  );
  const out: ActionRowBuilder<ButtonBuilder>[] = [navRow];
  if (rows.length > 0) {
    const detailButtons = rows.map((row, idx) => {
      const listNumber = session.page * MESSAGE_LOG_RESULTS_PER_PAGE + idx + 1;
      return new ButtonBuilder()
        .setCustomId(`${MESSAGE_LOG_DETAIL_PREFIX}${session.id}:${row.id}:0:img:open`)
        .setLabel(`詳細${listNumber}`)
        .setStyle(ButtonStyle.Secondary);
    });
    out.push(new ActionRowBuilder<ButtonBuilder>().addComponents(detailButtons));
  }
  return out;
}

export function buildListCardsPayload(session: SearchSession, rows: LogRow[], total: number, totalPages: number) {
  return {
    ...componentCardsPayload(
      [buildListCard(session, rows, total, totalPages)],
      buildListComponents(session, rows, total, totalPages),
    ),
    files: [],
  };
}

function buildDetailMetaCard(row: LogRow): ComponentCardBuilder {
  const states: string[] = [];
  if (row.edited_at) states.push(`編集済み: ${formatDiscordDate(row.edited_at)}`);
  if (row.deleted_at) states.push(`削除ログ: ${formatDiscordDate(row.deleted_at)}`);
  if (states.length === 0) states.push("通常");

  const channelId = snowflakeFromDb(row.channel_id);
  const primary = resolvePrimaryTimestamp(row);
  const gid = snowflakeFromDb(row.guild_id);
  const mid = snowflakeFromDb(row.message_id);
  const url = buildDiscordMessageUrl(gid, channelId, mid);

  const card = new ComponentCardBuilder()
    .setTitle(`メッセージログ詳細 #${row.id}`)
    .addFields({
      name: "投稿メタ情報",
      value: [
        `送信者: ${resolveSenderLine(row)}`,
        `チャンネル: ${channelId ? `<#${channelId}>` : "-"}`,
        `${primary.label}: ${formatDiscordDate(primary.iso)}`,
        `ログ種別: ${describeLogType(row.log_type)}`,
        `メッセージ種別: ${row.message_type || "-"}`,
        `状態: ${states.join(" / ")}`,
      ].join("\n"),
    });

  if (url) card.addFields({ name: "Discord メッセージURL", value: `[開く](${url})` });

  let replyRef: Record<string, unknown> | null = null;
  try {
    const p = row.reply_ref_json ? JSON.parse(row.reply_ref_json) : null;
    replyRef = p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
  } catch {
    replyRef = null;
  }
  if (replyRef) {
    const rMid = normalizeSnowflake(replyRef.message_id);
    const rCh = normalizeSnowflake(replyRef.channel_id);
    const rG = normalizeSnowflake(replyRef.guild_id) || gid;
    const rUrl = buildDiscordMessageUrl(rG, rCh, rMid);
    const rUser = normalizeSnowflake(replyRef.replied_user_id);
    const replyText = [
      `返信先メッセージID: ${rMid || "-"}`,
      `返信先チャンネル: ${rCh ? `<#${rCh}>` : "-"}`,
      rUser ? `返信先ユーザー: <@${rUser}>` : null,
      rUrl ? `[返信元を開く](${rUrl})` : null,
    ].filter(Boolean).join("\n");
    card.addFields({ name: "返信情報", value: replyText || "-" });
  }

  let embedSummaries: { type?: string; title?: string | null; description?: string | null }[] = [];
  try {
    const p = row.embeds_json ? JSON.parse(row.embeds_json) : [];
    embedSummaries = Array.isArray(p) ? p : [];
  } catch {
    embedSummaries = [];
  }
  if (embedSummaries.length > 0) {
    const summaryLines = embedSummaries.slice(0, 3).map((item, i) => {
      const bits = [
        `#${i + 1}`,
        item.type || "embed",
        item.title ? `title:${shortenText(String(item.title), 40)}` : null,
        item.description ? `desc:${shortenText(String(item.description), 60)}` : null,
      ].filter(Boolean);
      return bits.join(" | ");
    });
    card.addFields({
      name: `埋め込み要約 (${embedSummaries.length})`,
      value: summaryLines.join("\n"),
    });
  }
  return card;
}

function buildContentCards(content: string | null): ComponentCardBuilder[] {
  const source = String(content || "");
  if (!source) {
    return [new ComponentCardBuilder().setTitle("本文").setDescription("(本文なし)")];
  }
  const chunks = splitLongText(source, CONTENT_CHUNK);
  const out: ComponentCardBuilder[] = [];
  for (let i = 0; i < Math.min(chunks.length, MAX_CONTENT_EMBEDS); i += 1) {
    out.push(
      new ComponentCardBuilder()
        .setTitle(chunks.length > 1 ? `本文 (${i + 1}/${Math.min(chunks.length, MAX_CONTENT_EMBEDS)})` : "本文")
        .setDescription(chunks[i]!.slice(0, 4096)),
    );
  }
  if (chunks.length > MAX_CONTENT_EMBEDS) {
    const last = out[out.length - 1]!;
    const consumed = chunks.slice(0, MAX_CONTENT_EMBEDS).join("").length;
    const left = Math.max(0, source.length - consumed);
    last.setDescription(`${last.data.description || ""}\n\n… 残り ${left} 文字は省略`.slice(0, 4096));
  }
  return out;
}

function attachmentSummaryBlock(row: LogRow, storedMap?: Map<string, StoredAttachmentRow>): string {
  const raw = row.attachments_json || row.attachments || "[]";
  try {
    const arr = JSON.parse(String(raw)) as unknown[];
    if (!Array.isArray(arr) || arr.length === 0) return "(添付なし)";
    const map = storedMap ?? new Map();
    return arr
      .slice(0, 8)
      .map((a, i) => {
        const o = a && typeof a === "object" ? (a as Record<string, unknown>) : {};
        const fn = String(o.filename || o.name || "-");
        const u = String(o.url || o.proxy_url || "");
        const aid = String(o.id ?? "").trim();
        const stored = aid ? map.get(aid) : undefined;
        const line = `${i + 1}. ${fn}${u ? ` — ${u}` : ""}`;
        const hint = formatStoredHint(stored);
        return hint ? `${line}\n   ${hint}` : line;
      })
      .join("\n");
  } catch {
    return "(添付 JSON の解析に失敗)";
  }
}

function buildOversizeEphemeralCard(items: { filename: string; storageRelpath: string }[]): ComponentCardBuilder {
  const list = items.map((o) => `**${o.filename}**\n\`${o.storageRelpath}\``).join("\n\n");
  const desc =
    "ファイルサイズが大きく送信できなかったため、ダウンロードして閲覧してください。\n" +
    "ダウンロード時はウイルスに注意してください。\n\n" +
    list;
  return new ComponentCardBuilder()
    .setTitle("大きな添付ファイル")
    .setDescription(desc.slice(0, 4096));
}

export function buildDetailPayload(
  session: SearchSession,
  logId: number,
  imageIndexRequested: number,
  row: LogRow | undefined,
  slots: DetailImageSlotsResult,
  attachmentMap: Map<string, StoredAttachmentRow>,
): {
  cards: ComponentCardBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
  files: AttachmentBuilder[];
  ephemeralFollowUpCard?: ComponentCardBuilder;
} {
  if (!row) {
    return {
      cards: [new ComponentCardBuilder().setTitle("詳細").setDescription("ログが見つかりません。")],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`${MESSAGE_LOG_LIST_PREFIX}${session.id}:refresh`)
            .setLabel("一覧へ戻る")
            .setStyle(ButtonStyle.Secondary),
        ),
      ],
      files: [],
    };
  }
  const meta = buildDetailMetaCard(row);
  const bodyCards = buildContentCards(row.content);
  const gid = snowflakeFromDb(row.guild_id);
  const mid = snowflakeFromDb(row.message_id);
  const maxImgIdx = Math.max(0, slots.imageSlots.length - 1);
  const clampedIdx = slots.imageSlots.length === 0 ? 0 : Math.max(0, Math.min(imageIndexRequested, maxImgIdx));

  let attachDesc = attachmentSummaryBlock(row, attachmentMap);
  if (slots.oversizeItems.length > 0) {
    const extra = slots.oversizeItems.map((o) => `・${o.filename}\n  \`${o.storageRelpath}\``).join("\n");
    attachDesc = `${attachDesc}\n\n【8MB超の動画・ファイル（ローカルパス）】\n${extra}`;
  }
  if (slots.skippedImageCount > 0) {
    attachDesc = `${attachDesc}\n\n※ 画像 ${slots.skippedImageCount} 件は読み込みできませんでした。`;
  }
  const attachCard = new ComponentCardBuilder()
    .setTitle("添付一覧")
    .setDescription(attachDesc.slice(0, 4096))
    .setFooter({
      text:
        slots.imageSlots.length > 1
          ? "画像は「戻る」「次へ」で1枚ずつ表示。動画・ファイルは8MB以下を再送信。超過はパス参照。"
          : "画像は上のカードに表示。動画・ファイルは8MB以下を再送信。超過はパス参照。",
    });

  const imageCards: ComponentCardBuilder[] = [];
  if (slots.imageSlots.length > 0) {
    const cur = slots.imageSlots[clampedIdx]!;
    imageCards.push(
      new ComponentCardBuilder()
        .setTitle(`画像 ${clampedIdx + 1}/${slots.imageSlots.length}: ${cur.displayName}`)
        .setImage(`attachment://${cur.attachName}`),
    );
  }

  const cards = [meta, ...bodyCards, ...imageCards, attachCard].slice(0, 10);

  const files: AttachmentBuilder[] = [];
  if (slots.imageSlots.length > 0) {
    const cur = slots.imageSlots[clampedIdx]!;
    try {
      files.push(new AttachmentBuilder(cur.absPath, { name: cur.attachName }));
    } catch {}
  }
  files.push(...slots.nonImageFiles);

  const componentRows: ActionRowBuilder<ButtonBuilder>[] = [];
  if (slots.imageSlots.length > 1) {
    componentRows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`${MESSAGE_LOG_DETAIL_PREFIX}${session.id}:${logId}:${clampedIdx}:img:prev`)
          .setLabel("戻る")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(clampedIdx <= 0),
        new ButtonBuilder()
          .setCustomId(`${MESSAGE_LOG_DETAIL_PREFIX}${session.id}:${logId}:${clampedIdx}:img:next`)
          .setLabel("次へ")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(clampedIdx >= slots.imageSlots.length - 1),
      ),
    );
  }

  const back = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${MESSAGE_LOG_LIST_PREFIX}${session.id}:refresh`)
      .setLabel("一覧へ戻る")
      .setStyle(ButtonStyle.Secondary),
  );
  const cid = snowflakeFromDb(row.channel_id);
  const msgUrl = buildDiscordMessageUrl(gid, cid, mid);
  if (msgUrl) {
    back.addComponents(
      new ButtonBuilder().setLabel("元メッセージを開く").setStyle(ButtonStyle.Link).setURL(msgUrl),
    );
  }
  componentRows.push(back);

  return {
    cards,
    components: componentRows,
    files,
    ephemeralFollowUpCard: slots.oversizeItems.length > 0 ? buildOversizeEphemeralCard(slots.oversizeItems) : undefined,
  };
}
